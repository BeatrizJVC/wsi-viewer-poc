/**
 * Logs voluminosos (metadata DICOM completa, recursos FHIR) solo con ?debug=1.
 * Los errores no pasan por aquí: se siguen informando siempre.
 */
export function isDebug(search = globalThis.location?.search ?? "") {
  return new URLSearchParams(search).get("debug") === "1";
}

export function debugLog(...args) {
  if (isDebug()) {
    console.log(...args);
  }
}
