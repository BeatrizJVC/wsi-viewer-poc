/**
 * Montaje y limpieza de las herramientas alrededor del contenedor del visor.
 * Sin dependencias de OpenLayers ni del DOM global, para poder probarse en Node.
 *
 * Todas las funciones de limpieza devuelven un arreglo de errores en lugar de
 * lanzar: un paso que falla no impide ejecutar los siguientes.
 */

function attemptInto(errors, fn) {
  try {
    const result = fn();
    if (Array.isArray(result)) {
      errors.push(...result);
    }
  } catch (error) {
    errors.push(error);
  }
}

/** true si `node` es `ancestor` o está dentro de él (por parentNode). */
function isInside(node, ancestor) {
  for (let current = node; current; current = current.parentNode) {
    if (current === ancestor) return true;
  }
  return false;
}

/** Estado de interacciones de DMV antes de que las herramientas lo cambien. */
export function captureInteractionState(viewer) {
  return {
    draw: Boolean(viewer.isDrawInteractionActive),
    modify: Boolean(viewer.isModifyInteractionActive),
    dragZoom: Boolean(viewer.isDragZoomInteractionActive),
    dragPan: Boolean(viewer.isDragPanInteractionActive),
    roisVisible:
      typeof viewer.areROIsVisible === "boolean" ? viewer.areROIsVisible : undefined,
  };
}

/**
 * Desactiva las interacciones que pueden activar las herramientas y restaura
 * las que estaban activas al montarlas. Una interacción de dibujo previa no
 * se reactiva, porque sus opciones originales no son observables.
 * @returns {unknown[]} Errores ocurridos.
 */
export function restoreInteractionState(viewer, state) {
  const errors = [];
  attemptInto(errors, () => viewer.deactivateDrawInteraction());
  attemptInto(errors, () => viewer.deactivateModifyInteraction());
  attemptInto(errors, () => viewer.deactivateDragZoomInteraction());
  attemptInto(errors, () => viewer.deactivateDragPanInteraction());

  if (state?.dragPan) attemptInto(errors, () => viewer.activateDragPanInteraction());
  if (state?.dragZoom) attemptInto(errors, () => viewer.activateDragZoomInteraction());
  if (state?.modify) attemptInto(errors, () => viewer.activateModifyInteraction());

  if (typeof state?.roisVisible === "boolean") {
    attemptInto(errors, () => {
      if (viewer.areROIsVisible !== state.roisVisible) {
        state.roisVisible ? viewer.showROIs() : viewer.hideROIs();
      }
    });
  }
  return errors;
}

/**
 * Inserta `leading` y `layout` en la posición del contenedor y mueve el
 * contenedor dentro de `layout`.
 * @returns {() => unknown[]} restoreLayout: devuelve el contenedor a su
 *   posición original y retira los nodos insertados. Idempotente.
 */
export function mountAroundContainer(container, { leading = [], layout }) {
  const originalParent = container.parentNode;
  if (!originalParent) {
    throw new TypeError("El contenedor del visor debe estar insertado en el DOM.");
  }
  const originalNext = container.nextSibling;

  for (const node of leading) {
    originalParent.insertBefore(node, container);
  }
  originalParent.insertBefore(layout, container);
  layout.appendChild(container);

  let restored = false;
  return function restoreLayout() {
    if (restored) return [];
    restored = true;
    const errors = [];

    // Alternativas en orden de preferencia; si una falla se intenta la
    // siguiente. Solo cuenta como éxito si el contenedor salió del layout.
    const alternatives = [
      () => originalNext && originalNext.parentNode === originalParent &&
        originalParent.insertBefore(container, originalNext),
      // El hermano original ya no está: ocupar el lugar del layout.
      () => layout.parentNode && layout.parentNode.insertBefore(container, layout),
      () => originalParent.appendChild(container),
    ];
    for (const alternative of alternatives) {
      attemptInto(errors, alternative);
      if (!isInside(container, layout)) break;
    }

    for (const node of leading) {
      attemptInto(errors, () => node.remove());
    }
    // Nunca retirar el layout mientras contenga el contenedor: lo dejaría
    // desconectado del DOM.
    if (isInside(container, layout)) {
      errors.push(new Error("No se pudo restaurar el contenedor; el layout se conserva para no desconectarlo."));
    } else {
      attemptInto(errors, () => layout.remove());
    }
    return errors;
  };
}

/**
 * Compone la limpieza completa de las herramientas. Idempotente.
 * @returns {() => unknown[]} dispose: errores de la primera llamada;
 *   las llamadas siguientes devuelven [] sin efectos.
 */
export function createToolsDisposer({
  map,
  viewer,
  container,
  listenerKeys,
  unByKey,
  interactionState,
  restoreLayout,
}) {
  let disposed = false;
  return function dispose() {
    if (disposed) return [];
    disposed = true;
    const errors = [];
    attemptInto(errors, () => unByKey(listenerKeys));
    attemptInto(errors, () => restoreInteractionState(viewer, interactionState));
    attemptInto(errors, () => restoreLayout());
    attemptInto(errors, () => {
      if (container.parentNode && map.getTargetElement?.() === container) {
        map.updateSize();
      }
    });
    return errors;
  };
}
