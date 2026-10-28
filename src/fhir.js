const fhirBaseUrl = import.meta.env.VITE_FHIR_URL;

function stripTrailingSlash(value = '') {
    return value.replace(/\/$/, '');
}

function stripUrnOid(value = '') {
    return value.startsWith('urn:oid:')
        ? value.replace('urn:oid:', '')
        : value;
}

export async function getImagingStudyByCaseId(caseId) {
    if (!caseId) {
        throw new Error('No se indicó caseId.');
    }

    const imagingStudyId = caseId.startsWith('imgstudy-')
        ? caseId
        : `imgstudy-${caseId}`;

    const url =
        `${stripTrailingSlash(fhirBaseUrl)}/ImagingStudy/${imagingStudyId}`;

    console.log('Consultando ImagingStudy:', url);

    const response = await fetch(url, {
        headers: {
            Accept: 'application/fhir+json',
        },
    });

    if (!response.ok) {
        throw new Error(
            `No se pudo obtener ImagingStudy/${imagingStudyId}. HTTP ${response.status}`,
        );
    }

    return response.json();
}

export function extractDicomInfo(imagingStudy) {
    if (!imagingStudy) {
        throw new Error('ImagingStudy vacío.');
    }

    const identifiers = imagingStudy.identifier ?? [];

    let studyInstanceUID = null;

    for (const identifier of identifiers) {
        const value = identifier?.value;

        if (!value) continue;

        studyInstanceUID = stripUrnOid(value);
        break;
    }

    if (!studyInstanceUID) {
        throw new Error(
            'No se encontró StudyInstanceUID en ImagingStudy.identifier.',
        );
    }

    const series = imagingStudy.series ?? [];

    if (!series.length) {
        throw new Error(
            'El ImagingStudy no contiene series DICOM.',
        );
    }

    const firstSeries = series[0];

    const seriesInstanceUID = firstSeries.uid;

    if (!seriesInstanceUID) {
        throw new Error(
            'No se encontró SeriesInstanceUID en ImagingStudy.series[0].uid.',
        );
    }

    return {
        studyInstanceUID,
        seriesInstanceUID,
        instances: firstSeries.instance ?? [],
        endpointReferences: imagingStudy.endpoint ?? [],
    };
}