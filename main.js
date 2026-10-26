import * as DICOMwebClient from "dicomweb-client";
import * as DICOMMicroscopyViewer from "dicom-microscopy-viewer";

const status = document.getElementById("status");

const studyInstanceUID =
  "1.2.826.0.1.3680043.8.498.63359743326259253484214979519130767278";

const seriesInstanceUID =
  "1.2.826.0.1.3680043.8.498.99804338866843779327838057795676923899";

// IMPORTANTE:
// usamos /dicom-web para que Vite lo redirija internamente a Orthanc
const client = new DICOMwebClient.api.DICOMwebClient({
  url: "/dicom-web",
});

async function initViewer() {
  try {
    status.textContent = "Recuperando metadata DICOM...";

    const metadata = await client.retrieveSeriesMetadata({
      studyInstanceUID,
      seriesInstanceUID,
    });

    console.log("Metadata recibida:", metadata);

    const volumeImages = [];

    metadata.forEach((m) => {
      try {
        const image =
          new DICOMMicroscopyViewer.metadata.VLWholeSlideMicroscopyImage({
            metadata: m,
          });

        const imageFlavor = image.ImageType?.[2];

        console.log(
          "SOP:",
          image.SOPInstanceUID,
          "tipo:",
          imageFlavor
        );

        if (
          imageFlavor === "VOLUME" ||
          imageFlavor === "THUMBNAIL"
        ) {
          volumeImages.push(image);
        }
      } catch (err) {
        console.warn("Instancia omitida:", err);
      }
    });

    console.log("Imágenes VOLUME/THUMBNAIL:", volumeImages.length);

    if (volumeImages.length === 0) {
      throw new Error(
        "No se encontraron instancias VOLUME o THUMBNAIL."
      );
    }

    status.textContent =
      `Cargando WSI (${volumeImages.length} niveles/imágenes)...`;

    const viewer =
      new DICOMMicroscopyViewer.viewer.VolumeImageViewer({
        client,
        metadata: volumeImages,
      });

    viewer.render({
      container: "viewport",
    });

    status.textContent = "WSI cargada";
  } catch (error) {
    console.error(error);
    status.textContent = `Error: ${error.message}`;
  }
}

initViewer();
