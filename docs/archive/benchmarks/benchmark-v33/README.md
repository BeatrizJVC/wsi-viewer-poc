# OncoMETS WSI benchmark V3.3 — terminal transition barrier

V3.3 mide navegación automatizada con cobertura técnica verificable del nivel
objetivo. Ni LOADED ni rendercomplete demuestran completitud clínica, calidad de
tejido o presentación física de píxeles por la GPU. No mide apertura de caso ni
cambio de lámina. No ejecutarlo con datos reales para validar cambios de código.

## Una repetición en navegador, después de recargar

En una pirámide sintética local o entorno expresamente autorizado:

```js
const result = await window.oncometsBenchmarkV33.run({
  repetitions: 1,
  cacheCondition: 'uncontrolled',
  quietMs: 500,
  timeoutMs: 15000,
  cleanupTimeoutMs: 5000,
  debug: true
});
console.table(result.runs.map(r => ({
  step: r.label, terminal: r.terminal_state, reason: r.termination_reason,
  settled: r.technical_settled_ms,
  expected: r.technical_viewport_tile_coverage?.expected,
  loaded: r.technical_viewport_tile_coverage?.loaded,
  pending: r.residual_operations?.wado_pending
})));
window.oncometsBenchmarkV33.download();
```

Durante la ejecución:

```js
window.oncometsBenchmarkV33.cancel();       // solicita detener el protocolo
window.oncometsBenchmarkV33.disableDebug(); // oculta el panel sin cambiar medición
window.oncometsBenchmarkV33.destroy();      // solicita cancelar y oculta el panel
```

Cancelar no aborta las solicitudes del visor. Las promesas originales siguen su
curso. La salida espera una limpieza acotada y restaura todos los instrumentos;
`isRunning()` queda falso al terminar esa limpieza. `destroy()` solicita esa misma
salida segura. No sustituye el cleanup por una desconexión a mitad de una muestra.

Si hay ocho muestras completed, revisar expected=loaded, pending=0, checks verdaderos,
transiciones verificadas y limpieza drenada. La ejecución puede detenerse antes:
eso es el comportamiento requerido ante una incertidumbre o fallo. Revisar
`preparation`, `transition_failure`, `cleanup` y `reload_required`, además de `runs`.
Si reload_required es true, recargar antes de otra medición; no se reintenta sobre
pendientes que ya no pueden observarse tras restaurar los métodos.

## Protocolo y barreras

El recorrido medido conserva ocho pasos: horizontal nuevo candidato, diagonal nuevo
candidato, vertical nuevo candidato, retorno a base, revisita horizontal, retorno a
base, zoom-in, zoom-out. El pan es 0.85 FOV y zoom-in 1.5x. Repeticiones 1–30.
Región nueva es una etiqueta candidata: la preparación puede calentar cachés.

Se observan continuamente fuentes, cliente, frames, mapa y Resource Timing desde
antes de preparar hasta terminar limpieza. Primero se drenan las operaciones
observables del estado inicial. Las comprobaciones de restricciones de preparación
son síncronas: no renderizan cada posición candidata. Se renderiza y verifica la
base elegida con prezoom 8x, mínimo efectivo 3x, hasta 7 intentos con factor 1.7.
Preparación y barreras quedan separadas de las muestras de rendimiento.

Cada paso fija la geometría efectiva después del comando y antes del render:
centro, rotación, resolución, proyección, zoom y viewport. moveend y rendercomplete
sólo se aceptan si su frameState coincide con esa geometría. Un cambio posterior
de View, tamaño o selección de fuentes/tiles impide completarlo.

Estados terminales:

| Estado | Condición | Avance |
| --- | --- | --- |
| completed | Objetivo sin cambios, movimiento finalizado, tiles objetivo LOADED, operaciones drenadas, render objetivo posterior y estabilidad | Se verifica además una barrera antes del siguiente movimiento |
| failed | Error, timeout, movimiento nulo, interferencia o fallo de instrumentación | Detiene la secuencia |
| indeterminate | Geometría/fuente no soportada o pipeline/solicitud cuyo estado no se puede atribuir | Detiene la secuencia |
| cancelled | Cancelación solicitada | Detiene la secuencia |

`technical_settled_ms` sólo existe con valor numérico en completed. Un timeout de
cobertura faltante es failed, no un final exitoso por silencio. Si una transición
posterior invalida la salida, el paso precedente se reclasifica, su settled queda
null y conserva el tiempo provisional como diagnóstico separado, fuera de percentiles.

quietMs (500 por defecto) y timeoutMs (15000) son independientes. El silencio
empieza a contar después de los cambios de evidencia y nunca reemplaza cobertura,
operaciones drenadas ni render objetivo. betweenStepsMs=170 es una pausa mínima;
no concede permiso para avanzar. La barrera vuelve a verificar el campo anterior.
La preparación conserva una pausa mínima adicional de 1400 ms.

## Cobertura técnica

El denominador es geométrico e independiente de los getTile observados. Se usa
getRotatedViewport de OpenLayers con el centro efectivo de View.getState, resolución,
rotación y tamaño CSS. Las celdas deben intersectar con área positiva el polígono
recortado por grupos/capas/imagen/TileGrid. El rectángulo envolvente sólo enumera
candidatos. Se ignoran contactos sólo por borde/esquina con tolerancia numérica.

Cada fuente usa getZForResolution(resolution, source.zDirection), como el renderer.
Sólo se cuentan sus claves del nivel objetivo; no se sustituyen por padres más
gruesos. Se comprueban visibilidad, opacidad, límites de zoom/resolución, proyección
coincidente y fullTileRange. Rotación finita está admitida; reproyección, wrap,
transformaciones y capas raster no soportadas producen indeterminate. Vectores de
anotación no forman parte de cobertura raster. maxTiles=10000 limita el trabajo.

Un tile esperado no observado, EMPTY, nulo o recolectado por GC impide demostrar
cobertura; si no se resuelve dentro del timeout, el paso falla. Un LOADED puede
contener un tile vacío fabricado por el visor ante un frame ausente: no prueba
presencia de tejido. La caché previa de WebGL puede no ser observable; se conserva
esa incertidumbre sin reducir el denominador a lo solicitado.

## Solicitudes y procesamiento observable

main pasa el cliente existente a installBenchmarkV33(viewer, {client}). Durante
run se intercepta retrieveInstanceFrames con Reflect.apply(original,this,args).
El wrapper devuelve exactamente la misma promesa, respuesta o excepción original.
No lee opciones, resultados, buffers, URLs ni mensajes de error. Añade observadores
de settlement independientes; no reemplaza la promesa por una cadena .then/.finally.
Los tokens de seguimiento son anónimos y no se exportan.

getTile conserva su resultado/contexto/argumentos. Se envuelve temporalmente el
método público tile.load para asociar, durante su llamada síncrona, el inicio de
recuperación con ese objeto tile. Ambos métodos recuperan sus descriptores en cleanup.
No se invocan loaders ni cargas adicionales por esa instrumentación. Las referencias
de tiles son débiles y los payloads DOM se ignoran por completo.

Se distinguen:

- wado_pending: llamadas retrieveInstanceFrames observadas aún sin settlement.
  Incluye recuperación y procesamiento interno del cliente; no cuenta subrequests
  HTTP ni reintentos individuales.
- processing_observable_pending: tiles aún LOADING cuyo WADO asociado ya terminó.
  Incluye cola, decode, transformación y trabajo anterior al tile terminal. No es
  una medida aislada de ejecución del decodificador.
- unknown_operations: actividad sin contexto atribuible, promesas no observables,
  tiles LOADING sin recuperación asociada, cliente no instrumentable o cola no
  observable. Ausencia de eventos no se convierte automáticamente en cero trabajo.
- current_region_pending / previous_region_pending / other_region_pending:
  clasificación por pertenencia al conjunto objetivo y época de observación.
  inherited_wado_pending indica solicitudes iniciadas en una época anterior.

Todos los pendientes observados del mapa principal/cliente se drenan de forma
conservadora, aunque no pertenezcan al FOV actual. Un final heredado nunca descuenta
un token de otra solicitud ni cambia el estado de otro tile. Los eventos de frames
aportan contadores/tiempos, pero sus contadores agregados no prueban que una operación
concreta haya terminado. Una pipeline sin contexto seguro se declara indeterminada.

Las cargas anteriores al inicio de la instrumentación no pueden inventariarse
retrospectivamente. Sus tiles/colas/end events pueden aportar evidencia adicional,
pero no se afirma que el contador de requests cubra toda la historia de la página.
Resource Timing continuo aporta duraciones y respuestas heredadas separadas; no
decide por sí solo la ausencia de trabajo pendiente ni prueba tráfico de red nuevo.

## Cierre y lock

Un estado no completed detiene el recorrido. Se realiza drenaje acotado adicional
(cleanupTimeoutMs=5000). Sólo si drena se restaura la vista original y se vuelve a
comprobar el drenaje de las cargas que esa restauración pueda producir. Si no drena,
no se mueve el View para restaurarlo: se registra view_restored=false, residuales
y reload_required=true. Ningún resultado afirma haber cancelado requests.

finally restaura métodos/listeners/observadores y libera el lock compartido también
con error, timeout y cancelación. V2/V3.1/V3.2 mantienen sus protocolos y JSON.
El bloqueo es de la misma página, no de otras pestañas. La instrumentación puede
desactivarse mediante cancel/destroy; se restaura al terminar la limpieza acotada.

## JSON y compatibilidad

Archivo oncomets-benchmark-v33-<timestamp>.json, version 3.3, schema_version 3,
implementation_revision terminal-transition-barrier-1. Los JSON schema 1/2 anteriores
no se reescriben ni se mezclan silenciosamente con estas muestras.

Cada fila conserva estado/motivo terminal, tiempos, contadores, cronología limitada
a 20000 eventos, cobertura, comprobaciones, residuales y transición posterior.
preparation y cleanup tienen diagnósticos propios. El panel opcional muestra estos
conteos y la razón de espera, sin datos clínicos, geometría cruda, URLs o payloads.

Cambios respecto de schema 2:

- terminal_state y termination_reason son la autoridad sobre la finalización;
  validity se conserva para facilitar lectura (completed=valid; failed/cancelled=invalid).
- wado_count ahora cuenta inicios del método cliente; wado_resource_count conserva
  el conteo separado de recursos completados. No compararlos como métricas idénticas.
- pendingFrames se reemplaza por residual_operations con estados observables y desconocidos.
- frame_complete_ms queda null: ya no se presenta el último evento DOM agregado como
  finalización demostrada de los frames del paso.
- Sólo completed entra a p50/p95 por paso y estrato (WADO nuevo, caché, actividad sin
  WADO observado). Se conserva cada dato individual y duración Resource Timing.

cacheCondition es una declaración uncontrolled/cold-attempt/warm; no limpia cachés.
Una repetición no permite estimar una distribución: registrar n junto a percentiles.
Controlar externamente navegador, equipo, red, viewport y magnificación al comparar.

## Verificación local

```sh
node tests/benchmark-v33.test.mjs
npm run build -- --outDir /tmp/oncomets-v33-build
```

La suite usa mapas/colas/tiles/promesas sintéticos y la geometría OpenLayers instalada.
No abre páginas, WSI ni endpoints. Cubre cargas >500 ms, render temprano, nivel de
detalle objetivo, operaciones heredadas, fallos, caché, cancelación, timeout, bloqueo
de movimientos, identidad de promesas/errores, panel y restauración del protocolo.
