/**
 * Núcleo reutilizable del visor WSI, independiente de FHIR, de la worklist y
 * de elementos globales del DOM. Pensado para envolverse en un componente
 * React (ver docs/wsi-viewer-component.md).
 *
 * dicom-microscopy-viewer (DMV) y el cliente DICOMweb se inyectan para que el
 * núcleo pueda probarse sin navegador.
 *
 * LIMITACIÓN (DMV 0.49): `VolumeImageViewer.cleanup()` llama a
 * `webWorkerManager.terminateAllWebWorkers()`, que es global al módulo DMV y
 * detiene los workers de decodificación de TODAS las instancias. Por eso
 * `destroy()` solo llama a `cleanup()` cuando se destruye la última instancia
 * viva creada con esta función; en los demás casos hace una limpieza parcial
 * (desvincula el mapa del contenedor) y deja que el recolector libere el resto.
 */
import {
  buildPyramidImages,
  describeLevels,
  getBaseDimensions,
  rewriteBulkDataURIs,
} from "./dicom-metadata.js";
import { debugLog } from "./debug.js";

let liveInstances = 0;

/** Instancias creadas con createWsiViewer que aún no se destruyen. */
export function getLiveInstanceCount() {
  return liveInstances;
}

function abortError(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Carga del visor WSI cancelada.", "AbortError");
}

/**
 * @param {object} options
 * @param {object} options.dmv - Módulo dicom-microscopy-viewer.
 * @param {object} options.client - Instancia de DICOMwebClient.
 * @param {HTMLElement} options.container - Elemento donde se renderiza.
 * @param {string} options.studyInstanceUID
 * @param {string} options.seriesInstanceUID
 * @param {string} options.dicomWebUrl - Base DICOMweb efectiva (para BulkDataURI).
 * @param {AbortSignal} [options.signal] - Cancela la carga antes de renderizar.
 * @param {(message: string) => void} [options.onStatus]
 * @param {(error: Error, errorCount: number) => void} [options.onError] -
 *   Errores de carga/renderizado de tiles informados por DMV.
 * @param {object} [options.viewerOptions] - Opciones extra para VolumeImageViewer.
 */
export async function createWsiViewer({
  dmv,
  client,
  container,
  studyInstanceUID,
  seriesInstanceUID,
  dicomWebUrl,
  signal,
  onStatus = () => {},
  onError = () => {},
  viewerOptions = {},
}) {
  if (!dmv?.viewer?.VolumeImageViewer || !dmv?.metadata?.VLWholeSlideMicroscopyImage) {
    throw new TypeError("createWsiViewer requiere el módulo dicom-microscopy-viewer (dmv).");
  }
  if (typeof client?.retrieveSeriesMetadata !== "function") {
    throw new TypeError("createWsiViewer requiere un cliente DICOMweb.");
  }
  if (!container) {
    throw new TypeError("createWsiViewer requiere un contenedor.");
  }
  if (!studyInstanceUID || !seriesInstanceUID || !dicomWebUrl) {
    throw new TypeError("createWsiViewer requiere studyInstanceUID, seriesInstanceUID y dicomWebUrl.");
  }

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw abortError(signal);
    }
  };

  throwIfAborted();
  onStatus("Recuperando metadata DICOM...");

  // dicomweb-client no permite abortar esta petición: si se cancela mientras
  // está en curso, la respuesta se descarta y no se crea el visor. Si la
  // petición falla después de cancelar, se informa la cancelación.
  let metadata;
  try {
    metadata = await client.retrieveSeriesMetadata({
      studyInstanceUID,
      seriesInstanceUID,
    });
  } catch (error) {
    throwIfAborted();
    throw error;
  }
  throwIfAborted();

  debugLog("Metadata original recibida:", metadata);
  rewriteBulkDataURIs(metadata, dicomWebUrl, (from, to) =>
    debugLog("BulkDataURI reescrita:", from, "→", to)
  );
  debugLog("===== NIVELES WSI =====", describeLevels(metadata));

  const { images, skipped } = buildPyramidImages(
    metadata,
    instanceMetadata =>
      new dmv.metadata.VLWholeSlideMicroscopyImage({ metadata: instanceMetadata })
  );
  for (const { error } of skipped) {
    console.warn("Instancia omitida al construir VLWholeSlideMicroscopyImage:", error);
  }
  if (images.length === 0) {
    throw new Error("No se encontraron instancias VOLUME/THUMBNAIL.");
  }

  let destroyed = false;
  let errorCount = 0;

  // DMV lanza o registra el valor devuelto: debe devolver el mismo error y
  // nunca lanzar.
  const errorInterceptor = error => {
    if (!destroyed) {
      errorCount++;
      try {
        onError(error, errorCount);
      } catch (callbackError) {
        console.error("Error en onError del visor WSI:", callbackError);
      }
    }
    return error;
  };

  const viewer = new dmv.viewer.VolumeImageViewer({
    client,
    metadata: images,
    // Algunas miniaturas (caso 137092) codifican JPEG monocromático aunque
    // declaran SamplesPerPixel=3. Usar la pirámide VOLUME evita ese frame
    // auxiliar incompatible sin alterar los DICOM.
    skipThumbnails: true,
    ...viewerOptions,
    errorInterceptor,
  });

  liveInstances++;
  try {
    viewer.render({ container });
  } catch (error) {
    // La instancia fallida queda inactiva: deja de contar como viva y sus
    // errores tardíos ya no llegan a onError. La limpieza secundaria sigue la
    // misma regla que destroy() y nunca reemplaza el error original.
    destroyed = true;
    liveInstances--;
    const cleanupErrors = [];
    if (liveInstances === 0) {
      try {
        viewer.cleanup();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      viewer.getMap?.()?.setTarget(undefined);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length && error !== null && typeof error === "object") {
      try {
        error.cleanupErrors = cleanupErrors;
      } catch {
        // Error no extensible: se conserva tal cual.
      }
    }
    throw error;
  }

  /**
   * Destruye la instancia. Idempotente.
   *
   * La instancia queda destruida y el contador actualizado antes de limpiar,
   * aunque la limpieza falle. cleanup() (solo si es la última instancia viva)
   * y la desvinculación del mapa se intentan siempre por separado. Si alguna
   * falla, se lanza el primer error (el de cleanup() si ocurrió) y los
   * siguientes quedan en `error.cleanupErrors`.
   *
   * @returns {{ fullCleanup: boolean }} true si se llamó a viewer.cleanup().
   */
  function destroy() {
    if (destroyed) {
      return { fullCleanup: false };
    }
    destroyed = true;
    liveInstances--;

    const fullCleanup = liveInstances === 0;
    const errors = [];
    if (fullCleanup) {
      try {
        viewer.cleanup();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    try {
      viewer.getMap?.()?.setTarget(undefined);
    } catch (setTargetError) {
      errors.push(setTargetError);
    }

    if (errors.length) {
      const [primary, ...secondary] = errors;
      if (secondary.length) {
        let attached = false;
        if (primary !== null && typeof primary === "object") {
          try {
            primary.cleanupErrors = secondary;
            attached = true;
          } catch {
            // Error no extensible: se informa abajo.
          }
        }
        if (!attached) {
          console.error("Errores secundarios al destruir el visor WSI:", secondary);
        }
      }
      throw primary;
    }
    return { fullCleanup };
  }

  return {
    viewer,
    images,
    dimensions: getBaseDimensions(images),
    get errorCount() {
      return errorCount;
    },
    get destroyed() {
      return destroyed;
    },
    destroy,
  };
}
