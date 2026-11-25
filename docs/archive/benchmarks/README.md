# Benchmarks (documentación histórica)

Esta carpeta conserva la documentación de experimentos de rendimiento
realizados en versiones anteriores del visor WSI:

- `benchmarks.md`: descripción general de las mediciones de streaming WSI.
- `benchmark-v2/`: benchmark V2 (Resource Timing, long tasks, heap JS).
- `benchmark-v33/`: benchmark V3.3 (cobertura de tiles por navegación) y
  diagnóstico de eventos de rotación.

**Los benchmarks ya no forman parte del visor activo.** Sus módulos
(`src/benchmark-*.js`), pruebas (`tests/benchmark-v33.test.mjs`), scripts
(`benchmarks/`, `tools/install_benchmark_v2.py`) y la dependencia
`playwright` se retiraron del código para dejar el repositorio enfocado en un
visor WSI mínimo y reutilizable.

El código original sigue disponible en el historial de Git, por ejemplo en el
commit `d33a13d` ("Preserve integrated WSI benchmark V3.3 and AI outputs").

Las rutas, comandos y APIs (`window.oncometsBenchmark*`) mencionados en estos
documentos ya no existen en el código actual.
