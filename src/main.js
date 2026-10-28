import "ol/ol.css";

import * as DICOMwebClient from "dicomweb-client";
import * as DICOMMicroscopyViewer from "dicom-microscopy-viewer";

import {
  getImagingStudyByCaseId,
  extractDicomInfo,
} from "./fhir.js";

const status = document.getElementById("status");

// Endpoint DICOMweb configurable según el entorno.
//
// Desarrollo local:
//   VITE_DICOMWEB_URL=/dicom-web
//   Vite redirige las solicitudes hacia Orthanc.
//
// Producción:
//   VITE_DICOMWEB_URL=https://<endpoint>/dicom-web
//   El navegador consulta directamente el endpoint público.
const dicomWebUrl = import.meta.env.VITE_DICOMWEB_URL;

console.log("DICOMweb URL:", dicomWebUrl);

/**
 * Orthanc puede entregar algunos BulkDataURI como URLs absolutas,
 * por ejemplo:
 *
 * http://localhost:8042/dicom-web/...
 *
 * El visor debe reescribirlas usando el endpoint DICOMweb
 * configurado para el entorno actual.
 */
function rewriteBulkDataURIs(obj) {
  if (Array.isArray(obj)) {
    obj.forEach(rewriteBulkDataURIs);
    return;
  }

  if (!obj || typeof obj !== "object") {
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === "BulkDataURI" && typeof value === "string") {
      const dicomWebPathIndex = value.indexOf("/dicom-web/");

      if (dicomWebPathIndex !== -1) {
        const dicomWebPath = value.slice(
          dicomWebPathIndex + "/dicom-web".length
        );

        obj[key] =
          `${dicomWebUrl.replace(/\/$/, "")}${dicomWebPath}`;

        console.log(
          "BulkDataURI reescrita:",
          value,
          "→",
          obj[key]
        );
      }
    } else {
      rewriteBulkDataURIs(value);
    }
  }
}

async function initViewer() {
  try {
    // ---------------------------------------------------------
    // 1. Obtener caseId desde la URL
    // ---------------------------------------------------------

    const params = new URLSearchParams(window.location.search);

    // Valor por defecto solo para desarrollo / POC.
    const caseId = params.get("caseId") || "137092";

    console.log("Caso solicitado:", caseId);

    // ---------------------------------------------------------
    // 2. Consultar ImagingStudy en HAPI FHIR
    // ---------------------------------------------------------

    status.textContent =
      `Consultando ImagingStudy del caso ${caseId}...`;

    const imagingStudy =
      await getImagingStudyByCaseId(caseId);

    console.log(
      "ImagingStudy recuperado:",
      imagingStudy
    );

    // ---------------------------------------------------------
    // 3. Extraer identificadores DICOM desde ImagingStudy
    // ---------------------------------------------------------

    const {
      studyInstanceUID,
      seriesInstanceUID,
      instances,
    } = extractDicomInfo(imagingStudy);

    console.log(
      "StudyInstanceUID:",
      studyInstanceUID
    );

    console.log(
      "SeriesInstanceUID:",
      seriesInstanceUID
    );

    console.log(
      "Instancias FHIR:",
      instances.length
    );

    // ---------------------------------------------------------
    // 4. Crear cliente DICOMweb
    // ---------------------------------------------------------

    const client =
      new DICOMwebClient.api.DICOMwebClient({
        url: dicomWebUrl,
      });

    // ---------------------------------------------------------
    // 5. Recuperar metadata DICOM desde Orthanc
    // ---------------------------------------------------------

    status.textContent =
      "Recuperando metadata DICOM...";

    const metadata =
      await client.retrieveSeriesMetadata({
        studyInstanceUID,
        seriesInstanceUID,
      });

    console.log(
      "Metadata original recibida:",
      metadata
    );

    rewriteBulkDataURIs(metadata);

    // ---------------------------------------------------------
    // 6. Mostrar información de los niveles WSI
    // ---------------------------------------------------------

    console.log("===== NIVELES WSI =====");

    metadata.forEach(
      (instanceMetadata, index) => {
        try {
          const image =
            new DICOMMicroscopyViewer.metadata
              .VLWholeSlideMicroscopyImage({
                metadata: instanceMetadata,
              });

          const imageFlavor =
            image.ImageType?.[2];

          if (imageFlavor === "VOLUME") {
            const numberOfFrames =
              instanceMetadata["00280008"]
                ?.Value?.[0];

            const totalPixelMatrixColumns =
              instanceMetadata["00480006"]
                ?.Value?.[0];

            const totalPixelMatrixRows =
              instanceMetadata["00480007"]
                ?.Value?.[0];

            const pixelMeasures =
              instanceMetadata["52009229"]
                ?.Value?.[0]
                ?.["00289110"]
                ?.Value?.[0];

            const pixelSpacing =
              pixelMeasures?.["00280030"]
                ?.Value;

            console.log({
              nivel: index,
              sopInstanceUID:
                image.SOPInstanceUID,
              numberOfFrames,
              totalPixelMatrixColumns,
              totalPixelMatrixRows,
              pixelSpacing,
            });
          }
        } catch (error) {
          console.warn(
            "No se pudo leer nivel:",
            error
          );
        }
      }
    );

    console.log("========================");

    console.log(
      "Metadata después de reescribir BulkDataURI:",
      metadata
    );

    // ---------------------------------------------------------
    // 7. Construir pirámide WSI
    // ---------------------------------------------------------

    const volumeImages = [];

    metadata.forEach((instanceMetadata) => {
      try {
        const image =
          new DICOMMicroscopyViewer.metadata
            .VLWholeSlideMicroscopyImage({
              metadata: instanceMetadata,
            });

        const imageFlavor =
          image.ImageType?.[2];

        console.log(
          "SOP:",
          image.SOPInstanceUID,
          "tipo:",
          imageFlavor
        );

        // Solo VOLUME forma parte de la pirámide principal.
        // LABEL y THUMBNAIL se excluyen.
        if (imageFlavor === "VOLUME") {
          volumeImages.push(image);
        }
      } catch (error) {
        console.warn(
          "Instancia omitida al construir VLWholeSlideMicroscopyImage:",
          error
        );
      }
    });

    console.log(
      "Imágenes VOLUME encontradas:",
      volumeImages.length
    );

    if (volumeImages.length === 0) {
      throw new Error(
        "No se encontraron instancias VOLUME."
      );
    }

    // ---------------------------------------------------------
    // 8. Renderizar visor
    // ---------------------------------------------------------

    status.textContent =
      `Visor inicializado para caso ${caseId}: ` +
      `${volumeImages.length} niveles VOLUME. ` +
      "Recuperando frames...";

    const viewer =
      new DICOMMicroscopyViewer.viewer
        .VolumeImageViewer({
          client,
          metadata: volumeImages,
        });

    // Disponible desde DevTools para debugging.
    window.wsiViewer = viewer;

    viewer.render({
      container: "viewport",
    });

    status.textContent =
      `Caso ${caseId} cargado - ` +
      "frames bajo demanda...";

    console.log(
      "VolumeImageViewer renderizado:",
      viewer
    );
  } catch (error) {
    console.error(
      "Error inicializando visor WSI:",
      error
    );

    status.textContent =
      `Error al inicializar visor: ` +
      `${error?.message ?? error}`;
  }
}

initViewer();