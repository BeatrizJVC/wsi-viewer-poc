# OncoMETS — Benchmark de navegación V2

## Instalación

Aplicar el parche desde la raíz del repositorio, luego ejecutar el integrador:

```bash
git apply --check oncomets-browser-v2.patch
git apply oncomets-browser-v2.patch
python3 tools/install_benchmark_v2.py
npm run build
npm run dev
```

Activa automáticamente el panel en desarrollo, y en Vercel SOLO si la URL incluye `?benchmark=1` (o `&benchmark=1` cuando ya existe caseId).

El script **no sube resultados a ningún servidor**. `src/main.js` se respalda en `src/main.js.benchmark-v2-backup` antes de insertarse un import y una llamada después de `viewer.render({container:"viewport"})`. No guardes el respaldo en Git.

## Qué registrar

- Abre la WSI normalmente (esto NO mide TOC ni carga inicial).
- Realiza 5 pan a regiones nuevas, 5 pan de retorno, 5 zoom in, 5 zoom out, dejando que la interfaz se estabilice.
- Deja el visor abierto al menos 5 minutos, desplázate por regiones nuevas, y pulsa **Memoria** al inicio y final. Deja pasar un tiempo sin interactuar después de navegar para ver si se estabiliza.
- Pulsa **Exportar JSON** antes de salir de la página. Cambiar caso navega a otra página y puede perder las mediciones no exportadas.
- Repite 3 sesiones en condiciones comparables (resolución, equipo, red, mismo caso), distinguiendo caché del navegador (DevTools Disable cache), servidor e interna del viewer.

## Métricas

- `timing_kind=openlayers_rendercomplete`: si se pudo obtener el Map de OpenLayers, la métrica usa `rendercomplete` del mapa (todos los tiles actuales cargados y fades terminados). No implica que el contenido sea clínicamente interpretable en todo escenario.
- `timing_kind=network_quiet_proxy`: **no se pudo identificar el mapa**. La medición es el tiempo hasta detenerse nuevas respuestas HTTP por un período. NO es TFOV científicamente equivalente a Schüffler.
- `dicom_frames`: peticiones observadas `/dicom-web/.../frames/N`, agrupadas por región.
- `frame_levels`: intento de identificar nivel piramidal según SOPInstanceUID en `volumeImages`; si no está disponible, aparece `unknown`.
- `frame_http_duration_p50_ms` / p95: duración de cada recurso de frame observada por Resource Timing. No sumar estas duraciones para estimar tiempo visual.
- `js_heap`: memoria JavaScript estimada, no RAM del proceso ni memoria GPU.
- `raf_interval_p95_ms`: cadencia de animación de página; no garantiza imagen WSI completa.
- `bytes_visible_sum`: puede ser null por `Timing-Allow-Origin`, no inferir cero transferencias.

## Seguridad y límites

**Sólo lectura.** No captura imágenes, texto diagnóstico, UIDs ni URLs. El panel no pide token de acceso. Los resultados agregados quedan solo en el navegador hasta exportarlos. No activar de manera predeterminada en producción para usuarios clínicos.

No mide automáticamente TOC, TCS, tiempo al primer tile visible, ni uso total de GPU. Los cronómetros miden desde inicio del gesto hasta rendercomplete (si accesible) o hasta silencio de red; para latencia estricta desde fin del gesto revisa `interaction_to_complete_ms`. Si el POC no expone un Map OpenLayers accesible, habría que añadir acceso explícito a su mapa subyacente con una API confirmada de `dicom-microscopy-viewer`.

El gesto de pan comienza con `pointerdown`, se reconoce cuando el puntero se desplaza más de 12 px y termina con `pointerup`. Zoom por rueda, doble clic y controles nativos.

La instrumentación agrega observadores, temporizadores y UI; debe desactivarse fuera de mediciones al comparar rendimiento real.

Referencia: Schüffler et al., *Efficient Visualization of Whole Slide Images in Web-based Viewers for Digital Pathology* (2022). https://pmc.ncbi.nlm.nih.gov/articles/PMC10060618/
OpenLayers Map `rendercomplete`: https://openlayers.org/en/latest/apidoc/module-ol_Map-Map.html
MDN Resource Timing: https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming
