import { renderViewerTools } from './viewer-tools.js';
import "ol/ol.css";

import * as DICOMwebClient from "dicomweb-client";
import * as DICOMMicroscopyViewer from "dicom-microscopy-viewer";

import {
  resolveImagingForCase,
} from "./fhir.js";
import {
  prepareViewerMode,
  renderWorklist,
} from "./worklist.js";
import "./worklist.css";
import {
  renderSlideSelector,
} from "./slide-selector.js";
import "./slide-selector.css";
import { createWsiViewer } from "./wsi/create-wsi-viewer.js";
import { debugLog } from "./wsi/debug.js";

const status = document.getElementById("status");

async function bootstrap() {
  const params =
    new URLSearchParams(window.location.search);

  const caseId = params.get("caseId");

  if (caseId) {
    prepareViewerMode(caseId);
    await initViewer();
    return;
  }

  await renderWorklist();
}

bootstrap().catch((error) => {
  console.error(
    "Error inicializando aplicación:",
    error
  );

  if (status) {
    status.textContent =
      `Error inicializando aplicación: ` +
      `${error?.message ?? error}`;
  }
});

async function initViewer() {
  try {
    // ---------------------------------------------------------
    // 1. Obtener caseId desde la URL
    // ---------------------------------------------------------

    const params =
      new URLSearchParams(window.location.search);

    // Valor por defecto solo para desarrollo / POC.
    const caseId =
      params.get("caseId") || "137092";

    console.log(
      "Caso solicitado:",
      caseId
    );

    // ---------------------------------------------------------
    // 2. Resolver cadena FHIR completa
    //    caseId
    //      → DiagnosticReport
    //      → ImagingStudy
    //      → Endpoint
    //      → UID DICOM
    // ---------------------------------------------------------

    status.textContent =
      `Resolviendo imágenes del caso ${caseId} en FHIR...`;

    const {
      diagnosticReport,
      imagingStudy,
      imagingStudyReference,
      endpoint,
      studyInstanceUID,
      seriesInstanceUID,
      instances,
      dicomWebUrl,
    } = await resolveImagingForCase(caseId, {
      imagingStudyReference: params.get("imagingStudy"),
      seriesUID: params.get("seriesUID"),
    });

    const availableSeriesUIDs = (imagingStudy.series ?? []).filter(series => series?.uid);

    console.log(
      "Serie WSI activa:",
      seriesInstanceUID,
      `(${availableSeriesUIDs.length} serie(s) en ImagingStudy)`
    );

    // Recursos FHIR completos: solo con ?debug=1.
    debugLog("DiagnosticReport:", diagnosticReport);
    debugLog("ImagingStudy:", imagingStudy);
    debugLog("Endpoint:", endpoint);

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

    console.log(
      "DICOMweb URL efectiva:",
      dicomWebUrl
    );

    // ---------------------------------------------------------
    // 3. Crear cliente DICOMweb
    // ---------------------------------------------------------

    const client =
      new DICOMwebClient.api.DICOMwebClient({
        url: dicomWebUrl,
      });

    // ---------------------------------------------------------
    // 4. Metadata, pirámide WSI y render (núcleo reutilizable)
    // ---------------------------------------------------------

    const loadedMessage =
      `Caso ${caseId} cargado - ` +
      "frames bajo demanda...";
    let loaded = false;
    let tileErrors = 0;

    const showStatus = () => {
      if (!loaded) return;
      status.textContent = tileErrors
        ? `${loadedMessage} · ${tileErrors} error(es) de carga de tiles (ver consola)`
        : loadedMessage;
    };

    const handle = await createWsiViewer({
      dmv: DICOMMicroscopyViewer,
      client,
      container: document.getElementById("viewport"),
      studyInstanceUID,
      seriesInstanceUID,
      dicomWebUrl,
      onStatus: (message) => {
        status.textContent = message;
      },
      onError: (error, count) => {
        tileErrors = count;
        console.error("Error de carga del visor WSI:", error?.message ?? error);
        showStatus();
      },
    });

    const { viewer, images: volumeImages, dimensions } = handle;

    console.log(
      "Imágenes VOLUME/THUMBNAIL encontradas:",
      volumeImages.length
    );

    status.textContent =
      `Visor inicializado para caso ${caseId}: ` +
      `${volumeImages.length} niveles VOLUME. ` +
      "Recuperando frames...";

    // Disponible desde DevTools para debugging.
    window.wsiViewer = viewer;

    renderViewerTools({
      viewer,
      container: document.getElementById("viewport"),
      context: { caseId, imagingStudyReference, studyInstanceUID, seriesUID: seriesInstanceUID },
      dimensions,
    });

    renderSlideSelector({
      imagingStudy,
      imagingStudyReference,
      activeSeriesUID:
        seriesInstanceUID,
    });

    loaded = true;
    showStatus();

    debugLog(
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
