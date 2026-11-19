const fhirBaseUrl = import.meta.env.VITE_FHIR_URL;
const fallbackDicomWebUrl = import.meta.env.VITE_DICOMWEB_URL;

function stripTrailingSlash(value = "") {
    return value.replace(/\/$/, "");
}

function stripUrnOid(value = "") {
    return value.startsWith("urn:oid:")
        ? value.replace("urn:oid:", "")
        : value;
}

async function fetchFhirJson(url) {
    console.log("FHIR GET:", url);

    const response = await fetch(url, {
        headers: {
            Accept: "application/fhir+json",
        },
    });

    if (!response.ok) {
        throw new Error(
            `Error consultando FHIR: HTTP ${response.status} - ${url}`
        );
    }

    return response.json();
}

function normalizeFhirReference(reference, resourceType) {
    if (typeof reference !== "string") return null;
    const base = new URL(`${stripTrailingSlash(fhirBaseUrl)}/`, globalThis.location?.href).href;
    const relative = reference.startsWith(base)
        ? reference.slice(base.length)
        : reference.replace(/^\//, "");
    const [type, id, extra] = relative.split("/");
    if (type !== resourceType || extra !== undefined || !/^[A-Za-z0-9.-]{1,64}$/.test(id ?? "") ||
        id === "." || id === "..") return null;
    return relative;
}

function getStudyReferences(report) {
    return (report.imagingStudy ?? []).map(item =>
        normalizeFhirReference(item?.reference, "ImagingStudy")
    );
}

async function resolveStudyReference(caseId, requestedStudyReference) {
    const normalizedCaseId = caseId.replace(/^pat-/, "").replace(/^imgstudy-/, "");
    const patientReference = `Patient/pat-${normalizedCaseId}`;
    const searchUrl = new URL(`${stripTrailingSlash(fhirBaseUrl)}/DiagnosticReport`, globalThis.location?.href);
    searchUrl.searchParams.set("subject", patientReference);
    searchUrl.searchParams.set("_format", "json");

    const requested = normalizeFhirReference(requestedStudyReference, "ImagingStudy");
    if (requestedStudyReference !== null && !requested) {
        throw new Error("La referencia ImagingStudy solicitada no es válida.");
    }

    const studies = new Map();
    const visited = new Set();
    let hasUnresolvedReference = false;
    let page = searchUrl;
    while (page) {
        if (page.origin !== searchUrl.origin || page.pathname !== searchUrl.pathname ||
            visited.has(page.href)) {
            throw new Error("No se pudo verificar la paginación de estudios del caso.");
        }
        visited.add(page.href);
        const bundle = await fetchFhirJson(page.href);
        for (const { resource } of bundle.entry ?? []) {
            if (resource?.resourceType !== "DiagnosticReport") continue;
            if (normalizeFhirReference(resource.subject?.reference, "Patient") !== patientReference) continue;

            for (const reference of getStudyReferences(resource)) {
                if (reference === requested && requested) {
                    return { diagnosticReport: resource, imagingStudyReference: reference };
                }
                if (reference && !studies.has(reference)) studies.set(reference, resource);
                if (!reference) hasUnresolvedReference = true;
            }
        }
        const next = bundle.link?.find(link => link.relation === "next");
        if (next && !next.url) throw new Error("Enlace de paginación FHIR incompleto.");
        page = next ? new URL(next.url, page) : null;
    }

    if (requested) throw new Error("El estudio seleccionado no está vinculado al caso solicitado.");
    if (hasUnresolvedReference || studies.size > 1) {
        throw new Error("El estudio del caso es ambiguo. Seleccione un estudio desde la lista de casos.");
    }
    if (!studies.size) throw new Error("No se encontró un ImagingStudy vinculado al caso.");
    const [[imagingStudyReference, diagnosticReport]] = studies;
    return { diagnosticReport, imagingStudyReference };
}

/**
 * Recupera un recurso FHIR usando una referencia relativa,
 * por ejemplo:
 *
 * ImagingStudy/imgstudy-137092
 * Endpoint/orthanc-wado-rs
 */
export async function getFhirResourceByReference(reference) {
    if (!reference) {
        throw new Error("Referencia FHIR vacía.");
    }

    const url =
        `${stripTrailingSlash(fhirBaseUrl)}/` +
        reference.replace(/^\//, "");

    return fetchFhirJson(url);
}

function isDicomUID(value) {
    return typeof value === "string" && value.length <= 64 && /^\d+(?:\.\d+)+$/.test(value);
}

/**
 * Extrae StudyInstanceUID, SeriesInstanceUID e instancias
 * desde ImagingStudy.
 */
export function extractDicomInfo(imagingStudy, requestedSeriesUID = null) {
    const identifiers = imagingStudy.identifier ?? [];
    const dicomIdentifiers = identifiers.filter(identifier => identifier.system === "urn:dicom:uid");
    const oidIdentifiers = identifiers.filter(identifier => identifier.value?.startsWith("urn:oid:"));
    const candidates = dicomIdentifiers.length ? dicomIdentifiers
        : oidIdentifiers.length ? oidIdentifiers
        : identifiers.filter(identifier => !identifier.system && isDicomUID(identifier.value));
    const studyUIDs = new Set(candidates.map(identifier => stripUrnOid(identifier.value ?? "")));
    if ([...studyUIDs].some(uid => !isDicomUID(uid))) {
        throw new Error("El ImagingStudy contiene un identificador DICOM inválido.");
    }
    if (studyUIDs.size !== 1) {
        throw new Error("No se pudo identificar un StudyInstanceUID DICOM inequívoco.");
    }
    const [studyInstanceUID] = studyUIDs;

    const series = imagingStudy.series ?? [];
    // Preserve the default slide for links that omit seriesUID.
    const matches = requestedSeriesUID === null
        ? series.filter(item => item.uid === series[0]?.uid)
        : series.filter(item => item.uid === requestedSeriesUID);
    if (matches.length !== 1 || !isDicomUID(matches[0].uid)) {
        throw new Error("No se pudo identificar la serie solicitada en el estudio seleccionado.");
    }
    const [activeSeries] = matches;
    const endpointReference =
        activeSeries.endpoint?.[0]?.reference ??
        imagingStudy.endpoint?.[0]?.reference ??
        null;

    return {
        studyInstanceUID,
        seriesInstanceUID: activeSeries.uid,
        instances: activeSeries.instance ?? [],
        endpointReference,
    };
}

/**
 * Decide qué URL DICOMweb utilizar.
 *
 * Actualmente Endpoint.address puede seguir siendo:
 *   http://localhost:8042/dicom-web
 *
 * Ese valor no sirve desde Vercel, por lo que en ese caso
 * utilizamos VITE_DICOMWEB_URL.
 */
export function resolveDicomWebUrl(endpoint) {
    const endpointAddress =
        endpoint?.address?.replace(/\/$/, "");

    if (
        endpointAddress &&
        !endpointAddress.includes("localhost") &&
        !endpointAddress.includes("127.0.0.1")
    ) {
        return endpointAddress;
    }

    if (!fallbackDicomWebUrl) {
        throw new Error(
            "No existe un Endpoint DICOMweb utilizable ni VITE_DICOMWEB_URL."
        );
    }

    console.warn(
        "Endpoint.address no es accesible desde este entorno:",
        endpointAddress,
        "→ usando VITE_DICOMWEB_URL:",
        fallbackDicomWebUrl
    );

    return stripTrailingSlash(fallbackDicomWebUrl);
}

function extractCaseIdFromPatientReference(reference = "") {
    // Patient/pat-137092 -> 137092
    const match = reference.match(/Patient\/pat-(.+)$/);
    return match?.[1] ?? reference;
}

function getPatientDisplay(patient) {
    if (!patient) {
        return "Sin información";
    }

    const name = patient.name?.[0];

    if (name) {
        const family = name.family ?? "";
        const given = (name.given ?? []).join(" ");

        const fullName = `${given} ${family}`.trim();

        if (fullName) {
            return fullName;
        }

        if (name.text) {
            return name.text;
        }
    }

    const identifier =
        patient.identifier?.[0]?.value;

    return identifier ?? patient.id ?? "Sin información";
}

function getTissueFromImagingStudy(imagingStudy) {
    const series = imagingStudy?.series ?? [];

    for (const item of series) {
        const bodySite = item.bodySite;

        if (!bodySite) {
            continue;
        }

        if (bodySite.display) {
            return bodySite.display;
        }

        if (bodySite.text) {
            return bodySite.text;
        }

        if (bodySite.code) {
            return bodySite.code;
        }
    }

    return "No especificado";
}

function getSlideCount(imagingStudy) {
    if (
        typeof imagingStudy?.numberOfInstances === "number"
    ) {
        return imagingStudy.numberOfInstances;
    }

    return (imagingStudy?.series ?? []).reduce(
        (total, series) =>
            total + (series.instance?.length ?? 0),
        0
    );
}

function getCaseDate(diagnosticReport) {
    return (
        diagnosticReport.effectiveDateTime ??
        diagnosticReport.issued ??
        diagnosticReport.meta?.lastUpdated ??
        null
    );
}

function getDiagnosis(
    diagnosticReport,
    imagingStudy
) {
    return (
        diagnosticReport.conclusion ??
        diagnosticReport.code?.text ??
        imagingStudy?.description ??
        "Sin diagnóstico disponible"
    );
}

/**
 * Obtiene todos los casos disponibles para la Worklist.
 *
 * Flujo:
 *
 * DiagnosticReport
 *      ↓
 * Patient
 *      ↓
 * ImagingStudy
 *      ↓
 * objeto simplificado para la UI
 */
export async function getCases() {
    const url =
        `${stripTrailingSlash(fhirBaseUrl)}` +
        `/DiagnosticReport?_count=100&_format=json`;

    const bundle = await fetchFhirJson(url);

    const reports = (bundle.entry ?? [])
        .map((entry) => entry.resource)
        .filter(
            (resource) =>
                resource?.resourceType === "DiagnosticReport"
        );

    console.log(
        "DiagnosticReport encontrados:",
        reports.length
    );

    const reportStudies = reports.flatMap(diagnosticReport => {
        const references = new Set(getStudyReferences(diagnosticReport).filter(Boolean));
        return [...references].map(imagingStudyReference => ({ diagnosticReport, imagingStudyReference }));
    });

    const cases = await Promise.all(
        reportStudies.map(async ({ diagnosticReport, imagingStudyReference }) => {
            try {
                const patientReference =
                    normalizeFhirReference(diagnosticReport.subject?.reference, "Patient");

                if (!patientReference) {
                    console.warn(
                        "DiagnosticReport omitido por referencias incompletas:",
                        diagnosticReport.id
                    );

                    return null;
                }

                const caseId =
                    extractCaseIdFromPatientReference(
                        patientReference
                    );

                const [
                    patient,
                    imagingStudy,
                ] = await Promise.all([
                    getFhirResourceByReference(
                        patientReference
                    ),
                    getFhirResourceByReference(
                        imagingStudyReference
                    ),
                ]);

                const pathologist =
                    diagnosticReport.performer?.[0]
                        ?.display ??
                    "No especificado";

                return {
                    caseId,

                    diagnosticReportId:
                        diagnosticReport.id,

                    patientId:
                        patient.id,

                    patient:
                        getPatientDisplay(patient),

                    date:
                        getCaseDate(diagnosticReport),

                    status:
                        diagnosticReport.status ??
                        "unknown",

                    tissue:
                        getTissueFromImagingStudy(
                            imagingStudy
                        ),

                    diagnosis:
                        getDiagnosis(
                            diagnosticReport,
                            imagingStudy
                        ),

                    pathologist,

                    slideCount:
                        getSlideCount(imagingStudy),

                    imagingStudyReference,

                    imagingStudyId:
                        imagingStudy.id,

                    studyDescription:
                        imagingStudy.description ??
                        null,
                };
            } catch (error) {
                console.warn(
                    "No se pudo construir caso desde DiagnosticReport:",
                    diagnosticReport.id,
                    error
                );

                return null;
            }
        })
    );

    const validCases = cases.filter(Boolean);

    const uniqueCases = Array.from(
        new Map(
            validCases.map((item) => [
                `${item.caseId}::${item.imagingStudyReference}`,
                item,
            ])
        ).values()
    );

    return uniqueCases.sort((a, b) => {
        if (!a.date) return 1;
        if (!b.date) return -1;

        return new Date(b.date) - new Date(a.date);
    });
}

/**
 * Resuelve toda la cadena:
 *
 * caseId
 *   → DiagnosticReport
 *   → ImagingStudy
 *   → Endpoint
 *   → identificadores DICOM
 */
export async function resolveImagingForCase(caseId, {
    imagingStudyReference: requestedStudyReference = null,
    seriesUID = null,
} = {}) {
    const { diagnosticReport, imagingStudyReference } =
        await resolveStudyReference(caseId, requestedStudyReference);
    const imagingStudy = await getFhirResourceByReference(imagingStudyReference);
    if (imagingStudy.resourceType !== "ImagingStudy" ||
        `ImagingStudy/${imagingStudy.id}` !== imagingStudyReference) {
        throw new Error("FHIR devolvió un ImagingStudy distinto del estudio seleccionado.");
    }

    const {
        studyInstanceUID,
        seriesInstanceUID,
        instances,
        endpointReference,
    } = extractDicomInfo(imagingStudy, seriesUID);

    const normalizedEndpoint = normalizeFhirReference(endpointReference, "Endpoint");
    if (endpointReference !== null && !normalizedEndpoint) {
        throw new Error("La referencia Endpoint de la serie activa no es válida.");
    }
    const endpoint = normalizedEndpoint
        ? await getFhirResourceByReference(normalizedEndpoint)
        : null;
    if (endpoint && (endpoint.resourceType !== "Endpoint" ||
        `Endpoint/${endpoint.id}` !== normalizedEndpoint)) {
        throw new Error("FHIR devolvió un Endpoint distinto del asociado a la serie activa.");
    }

    return {
        caseId,
        diagnosticReport,
        imagingStudy,
        imagingStudyReference,
        endpoint,
        studyInstanceUID,
        seriesInstanceUID,
        instances,
        dicomWebUrl: resolveDicomWebUrl(endpoint),
    };
}
