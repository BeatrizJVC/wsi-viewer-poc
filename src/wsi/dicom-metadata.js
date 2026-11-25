/**
 * Funciones puras de procesamiento de metadata DICOM WSI (JSON DICOMweb).
 * No dependen del DOM, de FHIR ni de dicom-microscopy-viewer.
 */

const PYRAMID_FLAVORS = new Set(["VOLUME", "THUMBNAIL"]);

/**
 * Orthanc puede entregar algunos BulkDataURI como URLs absolutas,
 * por ejemplo http://localhost:8042/dicom-web/...
 * Se reescriben (in place) usando el endpoint DICOMweb efectivo.
 *
 * @param {unknown} obj - Metadata DICOM JSON (se modifica).
 * @param {string} dicomWebUrl - Base DICOMweb efectiva.
 * @param {(from: string, to: string) => void} [onRewrite]
 * @returns {number} Cantidad de URIs reescritas.
 */
export function rewriteBulkDataURIs(obj, dicomWebUrl, onRewrite) {
  if (Array.isArray(obj)) {
    return obj.reduce(
      (count, item) => count + rewriteBulkDataURIs(item, dicomWebUrl, onRewrite),
      0
    );
  }

  if (!obj || typeof obj !== "object") {
    return 0;
  }

  let count = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (key === "BulkDataURI" && typeof value === "string") {
      const dicomWebPathIndex = value.indexOf("/dicom-web/");

      if (dicomWebPathIndex !== -1) {
        const dicomWebPath = value.slice(
          dicomWebPathIndex + "/dicom-web".length
        );

        obj[key] = `${dicomWebUrl.replace(/\/$/, "")}${dicomWebPath}`;
        count++;
        onRewrite?.(value, obj[key]);
      }
    } else {
      count += rewriteBulkDataURIs(value, dicomWebUrl, onRewrite);
    }
  }
  return count;
}

/** Tercer valor de ImageType: VOLUME, THUMBNAIL, LABEL, OVERVIEW... */
export function getImageFlavor(image) {
  return image?.ImageType?.[2];
}

/**
 * VOLUME + THUMBNAIL forman la pirámide de visualización.
 * LABEL (y cualquier otro tipo) se excluye del visor principal.
 */
export function selectPyramidImages(images) {
  return images.filter(image => PYRAMID_FLAVORS.has(getImageFlavor(image)));
}

/**
 * Construye las imágenes de la pirámide a partir de la metadata cruda.
 * Las instancias que la fábrica no puede interpretar se omiten.
 *
 * @param {object[]} metadata - Metadata DICOM JSON por instancia.
 * @param {(instanceMetadata: object) => object} createImage - Fábrica,
 *   normalmente `new VLWholeSlideMicroscopyImage({ metadata })`.
 * @returns {{ images: object[], skipped: { index: number, error: unknown }[] }}
 */
export function buildPyramidImages(metadata, createImage) {
  const created = [];
  const skipped = [];

  metadata.forEach((instanceMetadata, index) => {
    try {
      created.push(createImage(instanceMetadata));
    } catch (error) {
      skipped.push({ index, error });
    }
  });

  return { images: selectPyramidImages(created), skipped };
}

/**
 * Dimensiones del nivel VOLUME de mayor resolución (TotalPixelMatrix).
 * @returns {{ width: number, height: number } | null}
 */
export function getBaseDimensions(images) {
  const base = images
    .filter(image => getImageFlavor(image) === "VOLUME")
    .reduce(
      (best, image) =>
        !best || image.TotalPixelMatrixColumns > best.TotalPixelMatrixColumns
          ? image
          : best,
      null
    );

  return base
    ? { width: base.TotalPixelMatrixColumns, height: base.TotalPixelMatrixRows }
    : null;
}

const tagValue = (instance, tag) => instance?.[tag]?.Value;

/**
 * Resumen técnico de los niveles VOLUME (solo para depuración).
 * Lee los tags directamente para no construir objetos del visor dos veces.
 */
export function describeLevels(metadata) {
  return metadata.flatMap((instance, index) => {
    if (tagValue(instance, "00080008")?.[2] !== "VOLUME") {
      return [];
    }

    const pixelMeasures = tagValue(instance, "52009229")?.[0]
      ?.["00289110"]?.Value?.[0];

    return [{
      nivel: index,
      sopInstanceUID: tagValue(instance, "00080018")?.[0],
      numberOfFrames: tagValue(instance, "00280008")?.[0],
      totalPixelMatrixColumns: tagValue(instance, "00480006")?.[0],
      totalPixelMatrixRows: tagValue(instance, "00480007")?.[0],
      pixelSpacing: pixelMeasures?.["00280030"]?.Value,
    }];
  });
}
