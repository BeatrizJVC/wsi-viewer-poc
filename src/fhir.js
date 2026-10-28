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