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

/**
 * Busca el DiagnosticReport asociado al paciente/caso.
 *
 * Convención actual de DICOM-FHIR:
 *   caseId = 137092
 *   Patient = Patient/pat-137092
 */
export async function getDiagnosticReportByCaseId(caseId) {
    if (!caseId) {
        throw new Error("No se indicó caseId.");
    }

    const normalizedCaseId = caseId
        .replace(/^pat-/, "")
        .replace(/^imgstudy-/, "");

    const patientReference = `Patient/pat-${normalizedCaseId}`;

    const url =
        `${stripTrailingSlash(fhirBaseUrl)}` +
        `/DiagnosticReport?subject=${encodeURIComponent(patientReference)}` +
        `&_format=json`;

    const bundle = await fetchFhirJson(url);

    const entries = bundle.entry ?? [];

    if (entries.length === 0) {
        throw new Error(
            `No se encontró DiagnosticReport para ${patientReference}.`
        );
    }

    // Por ahora usamos el primer DiagnosticReport que tenga ImagingStudy.
    const reportEntry = entries.find((entry) => {
        const resource = entry.resource;
        return (
            resource?.resourceType === "DiagnosticReport" &&
            Array.isArray(resource.imagingStudy) &&
            resource.imagingStudy.length > 0
        );
    });

    if (!reportEntry) {
        throw new Error(
            `Se encontraron DiagnosticReport para ${patientReference}, ` +
            "pero ninguno contiene referencia a ImagingStudy."
        );
    }

    return reportEntry.resource;
}

/**
 * Obtiene la referencia ImagingStudy desde DiagnosticReport.
 */
export function extractImagingStudyReference(diagnosticReport) {
    const references = diagnosticReport?.imagingStudy ?? [];

    if (references.length === 0) {
        throw new Error(
            "DiagnosticReport no contiene referencias a ImagingStudy."
        );
    }

    const reference = references[0]?.reference;

    if (!reference) {
        throw new Error(
            "La referencia a ImagingStudy está vacía."
        );
    }

    return reference;
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

/**
 * Extrae StudyInstanceUID, SeriesInstanceUID e instancias
 * desde ImagingStudy.
 */
export function extractDicomInfo(imagingStudy) {
    if (!imagingStudy) {
        throw new Error("ImagingStudy vacío.");
    }

    let studyInstanceUID = null;

    for (const identifier of imagingStudy.identifier ?? []) {
        const value = identifier?.value;

        if (!value) continue;

        studyInstanceUID = stripUrnOid(value);
        break;
    }

    if (!studyInstanceUID) {
        throw new Error(
            "No se encontró StudyInstanceUID en ImagingStudy.identifier."
        );
    }

    const series = imagingStudy.series ?? [];

    if (series.length === 0) {
        throw new Error(
            "El ImagingStudy no contiene series DICOM."
        );
    }

    // Actualmente cada WSI tiene una serie SM principal.
    const firstSeries = series[0];

    const seriesInstanceUID = firstSeries.uid;

    if (!seriesInstanceUID) {
        throw new Error(
            "No se encontró SeriesInstanceUID en ImagingStudy.series[0].uid."
        );
    }

    const endpointReference =
        imagingStudy.endpoint?.[0]?.reference ??
        firstSeries.endpoint?.[0]?.reference ??
        null;

    return {
        studyInstanceUID,
        seriesInstanceUID,
        instances: firstSeries.instance ?? [],
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

    const cases = await Promise.all(
        reports.map(async (diagnosticReport) => {
            try {
                const patientReference =
                    diagnosticReport.subject?.reference;

                const imagingStudyReference =
                    diagnosticReport.imagingStudy?.[0]
                        ?.reference;

                if (
                    !patientReference ||
                    !imagingStudyReference
                ) {
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
export async function resolveImagingForCase(caseId) {
    const diagnosticReport =
        await getDiagnosticReportByCaseId(caseId);

    console.log(
        "DiagnosticReport recuperado:",
        diagnosticReport
    );

    const imagingStudyReference =
        extractImagingStudyReference(diagnosticReport);

    console.log(
        "Referencia ImagingStudy:",
        imagingStudyReference
    );

    const imagingStudy =
        await getFhirResourceByReference(
            imagingStudyReference
        );

    console.log(
        "ImagingStudy recuperado:",
        imagingStudy
    );

    const {
        studyInstanceUID,
        seriesInstanceUID,
        instances,
        endpointReference,
    } = extractDicomInfo(imagingStudy);

    let endpoint = null;

    if (endpointReference) {
        endpoint =
            await getFhirResourceByReference(
                endpointReference
            );

        console.log(
            "Endpoint FHIR recuperado:",
            endpoint
        );
    } else {
        console.warn(
            "ImagingStudy no contiene Endpoint."
        );
    }

    const dicomWebUrl =
        resolveDicomWebUrl(endpoint);

    return {
        caseId,
        diagnosticReport,
        imagingStudy,
        endpoint,
        studyInstanceUID,
        seriesInstanceUID,
        instances,
        dicomWebUrl,
    };
}