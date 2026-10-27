import "ol/ol.css";

import * as DICOMwebClient from "dicomweb-client";
import * as DICOMMicroscopyViewer from "dicom-microscopy-viewer";

const status = document.getElementById("status");

const studyInstanceUID =
  "1.2.826.0.1.3680043.8.498.63359743326259253484214979519130767278";

const seriesInstanceUID =
  "1.2.826.0.1.3680043.8.498.99804338866843779327838057795676923899";

// Endpoint DICOMweb configurable según el entorno.
//
// Desarrollo local:
//   VITE_DICOMWEB_URL=/dicom-web
//   Vite redirige las solicitudes hacia Orthanc.
//
// Producción:
//   VITE_DICOMWEB_URL=https://<tunnel>/dicom-web
//   El navegador consulta directamente el endpoint público.
const dicomWebUrl = import.meta.env.VITE_DICOMWEB_URL;

console.log("DICOMweb URL:", dicomWebUrl);

const client = new DICOMwebClient.api.DICOMwebClient({
  url: dicomWebUrl,
});

/**
 * Orthanc entrega algunos BulkDataURI como URLs absolutas:
 *
 * http://localhost:8042/dicom-web/...
 *
 * Pero el navegador está ejecutando el visor desde:
 *
 * http://localhost:8082
 *
 * Para evitar CORS, reescribimos esas URLs para que pasen
 * por el proxy de Vite:
 *
 * /dicom-web/...
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
    status.textContent = "Recuperando metadata DICOM...";

    const metadata = await client.retrieveSeriesMetadata({
      studyInstanceUID,
      seriesInstanceUID,
    });

    console.log("Metadata original recibida:", metadata);

    rewriteBulkDataURIs(metadata);

    console.log("===== NIVELES WSI =====");

    metadata.forEach((instanceMetadata, index) => {
      try {
        const image =
          new DICOMMicroscopyViewer.metadata.VLWholeSlideMicroscopyImage({
            metadata: instanceMetadata,
          });

        const imageFlavor = image.ImageType?.[2];

        if (imageFlavor === "VOLUME") {
          const numberOfFrames =
            instanceMetadata["00280008"]?.Value?.[0];

          const totalPixelMatrixColumns =
            instanceMetadata["00480006"]?.Value?.[0];

          const totalPixelMatrixRows =
            instanceMetadata["00480007"]?.Value?.[0];

          const pixelMeasures =
            instanceMetadata["52009229"]?.Value?.[0]?.["00289110"]?.Value?.[0];

          const pixelSpacing =
            pixelMeasures?.["00280030"]?.Value;

          console.log({
            nivel: index,
            sopInstanceUID: image.SOPInstanceUID,
            numberOfFrames,
            totalPixelMatrixColumns,
            totalPixelMatrixRows,
            pixelSpacing,
          });
        }
      } catch (error) {
        console.warn("No se pudo leer nivel:", error);
      }
    });

    console.log("========================");

    console.log(
      "Metadata después de reescribir BulkDataURI:",
      metadata
    );

    const volumeImages = [];

    metadata.forEach((instanceMetadata) => {
      try {
        const image =
          new DICOMMicroscopyViewer.metadata.VLWholeSlideMicroscopyImage({
            metadata: instanceMetadata,
          });

        const imageFlavor = image.ImageType?.[2];

        console.log(
          "SOP:",
          image.SOPInstanceUID,
          "tipo:",
          imageFlavor
        );

        // IMPORTANTE:
        // Solo usamos VOLUME para construir la pirámide principal.
        // LABEL y THUMBNAIL se excluyen porque no forman parte
        // del volumen piramidal que renderiza VolumeImageViewer.
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

    status.textContent =
      `Visor inicializado: ${volumeImages.length} niveles VOLUME. ` +
      "Recuperando frames...";

    const viewer =
      new DICOMMicroscopyViewer.viewer.VolumeImageViewer({
        client,
        metadata: volumeImages,
      });

    // Disponible desde DevTools para debugging.
    window.wsiViewer = viewer;

    viewer.render({
      container: "viewport",
    });

    status.textContent =
      "Visor inicializado - cargando frames bajo demanda...";

    console.log("VolumeImageViewer renderizado:", viewer);
  } catch (error) {
    console.error(
      "Error inicializando visor WSI:",
      error
    );

    status.textContent =
      `Error al inicializar visor: ${error?.message ?? error}`;
  }
}

initViewer();
