# Corrección de rotación y eventos de frames — V3.3, schema 2

## Causas y evidencia previa al cambio

- La implementación original `benchmark-v33-core.js:16` rechazaba
  `v.getRotation() !== 0` antes de enumerar un solo tile. Un número exactamente
  cero (también -0) pasaba; cualquier rotación real, ruido numérico, undefined
  o NaN recibía el mismo motivo `rotation_unsupported`.
- El visor instalado no usa necesariamente rotación cero al presentar una lámina
  horizontal: `node_modules/dicom-microscopy-viewer/src/viewer.js:577–584`
  calcula orientación DICOM más pi/2; `:1480` la almacena y `:1544` la pasa a View.
  OpenLayers devuelve radianes. Sin el ángulo exportado ni una lectura del
  navegador no es posible reconstruir el valor exacto de las dos pruebas reales.
- `src/main.js` llamaba render con la cadena `"viewport"`. En `viewer.js:3315`
  esa misma cadena llega a targetElement del loader. `pyramid.js:549,592,609–610`
  publica started/ended/error; `eventPublisher.js:31` usa
  `el?.dispatchEvent?.(event)`, que sobre una cadena retorna undefined.
  Por ello los listeners del HTMLElement no reciben los eventos. Se comprobó
  también el contenido correspondiente del source map del bundle importado.
  La corrección mínima es pasar el HTMLElement desde main, sin editar la dependencia.
- El original `benchmark-v33.js:65` activaba el sink de tiles sólo dentro del paso;
  Resource Timing descartaba recursos con startTime anterior a t0 (`:56`). Las
  cargas de preparación o de un paso anterior pueden terminar con tileloadend
  dentro de la muestra y WADO=0. Los tres finales de la segunda prueba son
  compatibles con ello; sus contadores agregados no prueban esa atribución.
- `technical_settled_ms` original (`:102`) sólo se asignaba para validity=valid.
  La falla geométrica bastaba para anularlo. También lo anulan errores, timeout,
  interferencias, movimiento nulo o evidencia insuficiente de finalización.
  La ausencia de eventos de frames por sí sola NO excluía: pendingFrames era cero.

## Correcciones y evidencia nueva

V3.3 ahora admite polígonos rotados recortados por extents efectivos. Conserva
`rotation_radians`, `geometry_method` y todos los contadores geométricos, incluso
cuando falte evidencia de carga. Valores de geometría no finitos producen
`invalid_view_geometry`; no se fuerzan a cero ni se gira la lámina.

Los eventos de tiles incorporan correlación por objeto en WeakMap durante la
ejecución. Se exportan sólo cantidades: `tile_end_without_step_start` y
`tile_end_without_run_start`. Un inicio observado durante preparación cuenta
como inicio del run, pero no del paso siguiente. Un tile terminado cuyo getTile
no se observó puede incorporarse al registro mediante su evento de ciclo de vida;
no se crean tiles ni se leen píxeles. Errores y eventos quedan limitados al mapa principal.

`frame_end_without_step_start` indica finalizaciones sin un inicio pendiente en
la muestra (conteo, no correlación individual de frames). La instrumentación de
frames sigue sin leer payloads ni identificadores. `frame_event_evidence` evita
interpretar cero eventos como prueba de ausencia de decode.

`completion_checks` muestra movimiento terminado, render posterior a datos y
movimiento, frames drenados, cobertura establecida/completa y ventana de estabilidad.
Permite identificar por qué technical_settled_ms sigue siendo null. Se conservan
exclusion_reasons y la separación de caché/WADO/actividad no observable. No se
relajan filtros para convertir resultados indeterminados en válidos.

## Revalidación manual después de recargar la aplicación corregida

Primero consultar, sin iniciar un benchmark ni leer datos clínicos:

```js
window.wsiViewer.getMap().getView().getRotation() // número en radianes
window.wsiViewer.getMap().getTargetElement() instanceof HTMLElement // true
```

En una pirámide sintética local o un entorno autorizado, ejecutar una sola versión:

```js
const result = await window.oncometsBenchmarkV33.run({
  repetitions: 1, cacheCondition: 'uncontrolled'
});
console.table(result.runs.map(r => ({
  step: r.label, validity: r.validity,
  rotation: r.technical_viewport_tile_coverage?.rotation_radians,
  expected: r.technical_viewport_tile_coverage?.expected,
  loaded: r.technical_viewport_tile_coverage?.loaded,
  reason: r.exclusion_reasons?.join(', '),
  settled: r.technical_settled_ms,
  framesStart: r.frame_started, framesEnd: r.frame_ended,
  inheritedEnds: r.tile_end_without_step_start,
  unobservedStarts: r.tile_end_without_run_start
})));
window.oncometsBenchmarkV33.download();
```

Comprobar revision y schema 2, ángulo finito, ausencia de rotation_unsupported,
denominador esperado positivo dentro de imagen y loaded=expected en muestras válidas.
Con actividad nueva del loader deben aparecer eventos de frames (en datos dispersos
el visor puede fabricar tiles vacíos sin descarga/decode). En revisitas totalmente
resueltas desde caché pueden seguir en cero: exigir cobertura verificable y ausencia
de actividad antes de aceptar valid_cached_tiles. Una caché interna no observable
permanece indeterminada; cero WADO no basta para afirmar caché.

Con cargas nuevas exitosas iniciadas dentro del paso se esperan started y ended,
pendingFrames=0, render posterior, estabilidad satisfecha y settled finito. Una
carga iniciada antes del paso puede elevar tile_end_without_step_start sin elevar
tile_end_without_run_start. Si el inicio fue anterior a toda instrumentación,
ambos contadores aumentarán. Son evidencias de ventanas de observación diferentes,
no prueba automática de pérdida de solicitudes.

La corrección no vuelve válidos los ocho pasos por decreto: otras exclusiones
deben conservarse. No permite reinterpretar rendercomplete o LOADED como
completitud clínica ni medir decode aislado. Ninguna prueba real se ejecutó como
parte de este cambio; sólo pruebas sintéticas y compilación local.
