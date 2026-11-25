# Núcleo del visor WSI (`src/wsi/`)

Este documento describe la API reutilizable del visor y cómo envolverla en un
componente React (por ejemplo, dentro de OncoMETS). El núcleo **no** depende de
FHIR, de la worklist, de elementos globales del DOM ni de React.

| Archivo | Contenido |
|---|---|
| `src/wsi/create-wsi-viewer.js` | `createWsiViewer()` y `getLiveInstanceCount()` |
| `src/wsi/dicom-metadata.js` | Funciones puras sobre metadata DICOM JSON |
| `src/wsi/debug.js` | `isDebug()` / `debugLog()` (`?debug=1`) |
| `src/wsi/package.json` | `"type": "module"` para que Node ejecute las pruebas como ESM (el resto del proyecto declara `commonjs`) |
| `src/wsi/tools-lifecycle.js` | Montaje alrededor del contenedor y limpieza de las herramientas (probado en Node) |
| `src/viewer-tools.js` | Herramientas y panel IA de la POC; devuelve `dispose()` |

Dependencias verificadas: `dicom-microscopy-viewer` 0.49.0 (DMV),
`dicomweb-client` 0.11.3, `ol` 10.11.0.

## `createWsiViewer(options)`

```js
import * as DICOMMicroscopyViewer from "dicom-microscopy-viewer";
import * as DICOMwebClient from "dicomweb-client";
import { createWsiViewer } from "./wsi/create-wsi-viewer.js";

const handle = await createWsiViewer({
  dmv: DICOMMicroscopyViewer,                 // módulo DMV (inyectado)
  client: new DICOMwebClient.api.DICOMwebClient({ url: dicomWebUrl }),
  container,                                  // HTMLElement con tamaño definido
  studyInstanceUID,
  seriesInstanceUID,
  dicomWebUrl,                                // base usada para reescribir BulkDataURI
  signal,                                     // AbortSignal opcional
  onStatus: (message) => {},                  // opcional
  onError: (error, errorCount) => {},         // opcional: errores de tiles (DMV)
  viewerOptions: {},                          // opcional: opciones extra de VolumeImageViewer
});
```

Flujo interno:

1. Valida argumentos (lanza `TypeError`).
2. `client.retrieveSeriesMetadata({ studyInstanceUID, seriesInstanceUID })`:
   **una sola** petición de metadata. La WSI **no** se descarga completa.
3. `rewriteBulkDataURIs()` sobre la metadata.
4. Construye `VLWholeSlideMicroscopyImage` y conserva `VOLUME` + `THUMBNAIL`
   (excluye `LABEL`/`OVERVIEW`). Si no hay ninguna, lanza un error.
5. `new VolumeImageViewer({ client, metadata, skipThumbnails: true, ...viewerOptions, errorInterceptor })`
   y `viewer.render({ container })`.
6. DMV pide los frames **bajo demanda** (WADO-RS `.../frames/{n}`, un tile por
   frame, decodificados en web workers).

Devuelve:

| Propiedad | Descripción |
|---|---|
| `viewer` | Instancia `VolumeImageViewer` (DMV) |
| `images` | Imágenes de la pirámide usadas |
| `dimensions` | `{ width, height }` del VOLUME de mayor resolución, o `null` |
| `errorCount` | Errores de carga/renderizado informados por DMV |
| `destroyed` | `true` tras `destroy()` |
| `destroy()` | Destruye la instancia; idempotente. Devuelve `{ fullCleanup }`. La instancia queda destruida y el contador actualizado aunque la limpieza falle; si `cleanup()` o `setTarget()` fallan, lanza el primer error (el de `cleanup()` si ocurrió) con los demás en `error.cleanupErrors` |

### Cancelación (`signal`)

- Si la señal ya está abortada, no se consulta DICOMweb.
- Si se aborta mientras llega la metadata, la promesa se rechaza con
  `AbortError` y **no se construye ni se renderiza** el visor. Si la petición
  falla (por ejemplo, error de red) después de abortar, también se rechaza con
  `AbortError`; sin cancelación, el error real se propaga intacto.
- `dicomweb-client` no permite abortar la petición en curso: la respuesta llega
  igualmente y se descarta.
- Abortar **después** de que la promesa se resolvió no destruye nada: hay que
  llamar a `destroy()`.

### Errores de carga (`onError`)

Se conecta mediante la opción `errorInterceptor` de DMV, que se invoca en
`tileloaderror` y errores de capa. El interceptor siempre devuelve el mismo
error (DMV a veces lo relanza) y aísla excepciones de `onError`. Tras
`destroy()` los errores tardíos ya no se cuentan.

### Destrucción y workers (limitación de DMV 0.49)

`VolumeImageViewer.cleanup()` termina **todos** los web workers de decodificación
(`webWorkerManager.terminateAllWebWorkers()`), y ese gestor es **global al
módulo DMV**. Para no detener los workers de otras instancias:

- El núcleo cuenta las instancias vivas creadas con `createWsiViewer`
  (`getLiveInstanceCount()`).
- `destroy()` de la **última** instancia viva: `viewer.cleanup()` completo +
  desvincular el mapa (`setTarget(undefined)`) → `{ fullCleanup: true }`.
- `destroy()` con **otras instancias vivas**: solo desvincula el mapa del
  contenedor → `{ fullCleanup: false }`. Capas, fuentes y suscripciones de esa
  instancia no se liberan explícitamente; quedan para el recolector de basura.
  Los tiles que aún estaban en curso terminan y se descartan.
- Tras un `cleanup()` completo, DMV vuelve a crear los workers bajo demanda al
  decodificar el siguiente tile.
- Si `render()` falla, la instancia queda inactiva: deja de contar como viva,
  sus errores tardíos no llegan a `onError`, se aplica la misma regla de
  limpieza (`cleanup()` solo si no quedan otras instancias vivas) y se
  desvincula el mapa. Se propaga el error original; si la limpieza secundaria
  también falla, esos errores quedan en `error.cleanupErrors`.

Verificado (DMV real, navegador headless, WSI real servida por Orthanc):

- Destruir una instancia mientras otra cargaba tiles: no se llamó a `cleanup()`,
  la otra instancia siguió decodificando tiles nuevos sin errores y el visor
  principal siguió funcionando.
- Destruir la última instancia (`cleanup()` completo) y crear otra: la nueva
  renderiza y hace zoom sin errores (escenario de React StrictMode).
- Instancia abortada durante la carga de metadata: `AbortError`, sin render.
- `destroy()` repetido: sin efectos adicionales.

**Limitaciones que siguen vigentes:**

- El contador solo conoce instancias creadas con `createWsiViewer`. Si otro
  código crea `VolumeImageViewer` directamente y llama a `cleanup()`, detendrá
  los workers de todas.
- Varias instancias simultáneas funcionan en la prueba anterior, pero la
  limpieza parcial puede retener memoria hasta que la instancia deja de estar
  referenciada. No se midió el consumo de memoria con muchas instancias.
- `destroy()` no vacía el contenedor completo; solo retira el viewport de
  OpenLayers. El contenedor pertenece a quien lo creó.

## Integración con React (propuesta, no implementada)

```tsx
function WsiViewer({ dicomWebUrl, studyInstanceUID, seriesInstanceUID }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let handle: WsiViewerHandle | null = null;

    createWsiViewer({
      dmv: DICOMMicroscopyViewer,
      client: new DICOMwebClient.api.DICOMwebClient({ url: dicomWebUrl }),
      container: containerRef.current!,
      studyInstanceUID, seriesInstanceUID, dicomWebUrl,
      signal: controller.signal,
    }).then(
      h => { if (controller.signal.aborted) h.destroy(); else handle = h; },
      e => { if (e.name !== "AbortError") console.error(e); },
    );

    return () => {          // StrictMode monta → desmonta → monta en desarrollo
      controller.abort();   // si la metadata aún no llega, no se renderiza
      handle?.destroy();    // si ya se renderizó, se destruye (idempotente)
    };
  }, [dicomWebUrl, studyInstanceUID, seriesInstanceUID]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
```

Notas para OncoMETS:

- DMV no publica tipos TypeScript: hará falta un `declare module "dicom-microscopy-viewer"`.
- DMV busca su worker y los WASM en `/static/js/` (`window.PUBLIC_URL` /
  `window.PUBLIC_LIB_URL` permiten cambiarlo). Esta POC los sirve desde
  `public/static/js/`.
- Si se usan las herramientas de la POC, llamar al `dispose()` que devuelve
  `renderViewerTools()` antes de `destroy()`. `dispose()` retira los listeners
  del mapa, desactiva las interacciones de las herramientas y restaura las que
  estaban activas al montarlas (pan, zoom por arrastre, edición y visibilidad
  de ROI; un dibujo previo no se reactiva), devuelve el contenedor a su
  posición (si falla, prueba el lugar del layout y luego el final del padre
  original; nunca retira el layout mientras contenga el contenedor), retira
  los nodos creados y llama a `map.updateSize()` si el mapa sigue apuntando al
  contenedor. Es idempotente y no lanza: devuelve un arreglo con los errores
  de limpieza (vacío si todo fue bien).
- Autenticación, proxy DICOMweb y persistencia **no** forman parte de este
  núcleo; se pasan desde fuera (por ejemplo, el `client` ya configurado).

## Funciones puras (`dicom-metadata.js`)

| Función | Uso |
|---|---|
| `rewriteBulkDataURIs(metadata, dicomWebUrl, onRewrite?)` | Reescribe in place los BulkDataURI que contienen `/dicom-web/`; devuelve la cantidad |
| `getImageFlavor(image)` | `ImageType[2]` |
| `selectPyramidImages(images)` | Conserva `VOLUME` y `THUMBNAIL` |
| `buildPyramidImages(metadata, createImage)` | Construye con una fábrica y separa las instancias inválidas (`skipped`) |
| `getBaseDimensions(images)` | Dimensiones del VOLUME más grande |
| `describeLevels(metadata)` | Resumen de niveles VOLUME desde los tags (solo depuración) |

## Depuración (`?debug=1`)

Sin el parámetro no se imprimen la metadata DICOM completa, los BulkDataURI
reescritos, el resumen de niveles ni los recursos FHIR completos
(DiagnosticReport, ImagingStudy, Endpoint). Los errores y advertencias se
informan siempre.

## Transfer syntaxes y decodificadores

Consulta de solo lectura al Orthanc local (metadata interna `TransferSyntax` y
`SopClassUid` de cada instancia, 2026-11-24; solo conteos):

| SOP Class | Transfer Syntax | Instancias | Compatible hoy |
|---|---|---|---|
| VL Whole Slide Microscopy Image (`1.2.840.10008.5.1.4.1.1.77.1.6`) | JPEG Baseline 8-bit (`1.2.840.10008.1.2.4.50`) | 217 | **Sí** (`libjpegturbowasm_decode.wasm`) |
| Microscopy Bulk Simple Annotations (`1.2.840.10008.5.1.4.1.1.91.1`) | Explicit VR Little Endian (`1.2.840.10008.1.2.1`) | 3 | No aplica: no es una imagen; el visor actual no las carga |
| Parametric Map (`1.2.840.10008.5.1.4.1.1.30`) | Explicit VR Little Endian (`1.2.840.10008.1.2.1`) | 1 | No aplica: el visor actual no la carga |

Decodificadores servidos en `public/static/js/` (idénticos a los de DMV 0.49):
`dataLoader.worker.min.js`, `libjpegturbowasm_decode.wasm`, `dicomiccwasm.wasm`.

DMV 0.49 incluye además (en `node_modules/dicom-microscopy-viewer/dist/dynamic-import/`)
decodificadores **no copiados**: `openjpegwasm_decode.wasm` (JPEG 2000),
`openjphjs.wasm` (HTJ2K), `charlswasm_decode.wasm` (JPEG-LS) y
`jpegxlwasm_decode.wasm` (JPEG-XL). Con las WSI disponibles hoy no son
necesarios; habría que copiarlos si se incorporan láminas con esas
compresiones.

## Limitaciones conocidas fuera de este alcance

- `main.js` mantiene `window.wsiViewer` para depuración desde DevTools.
- "Restablecer vista" (`viewer-tools.js`) guarda la vista inicial antes de
  `map.updateSize()`, por lo que vuelve a un zoom levemente distinto del
  mostrado al cargar (comportamiento previo, no corregido).
- `skipThumbnails: true` se mantiene por una miniatura incompatible del caso
  137092.
