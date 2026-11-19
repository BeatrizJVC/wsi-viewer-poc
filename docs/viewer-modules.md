# Vistas y módulos del visualizador

## Flujo

```mermaid
flowchart LR
  A[Lista de casos / biopsias] --> B[Detalle e informe FHIR]
  B --> C[Visor de lámina]
  C --> D[Selector de láminas]
  D --> C
  C --> E[Resultados iniciales IA por modelo]
  E --> F[Feedback local por caso, lámina y modelo]
```

La lista conserva los filtros por tejido y estado, búsqueda por caso, paciente,
descripción de biopsia e informe. El informe FHIR puede haber sido corregido: no
se presenta como inferencia original. Las predicciones originales se cargan por
JSON en el visor y permanecen separadas del feedback; no se escribe a FHIR.

## Identidad de caso, estudio y lámina

La lista abre el visor con `caseId` e `imagingStudy`, una referencia al estudio
seleccionado. El visor comprueba el vínculo en los DiagnosticReport del caso.
Una URL antigua con solo `caseId` sigue funcionando si se verifica un único
estudio. Cuando hay varios estudios, se debe elegir uno desde la lista.
Al cambiar de lámina, el selector conserva la referencia del estudio y añade
`seriesUID`. La serie activa aporta sus instancias y su endpoint, con el
endpoint del estudio como alternativa. Si no se indica una lámina, se conserva
la primera serie como lámina inicial del estudio verificado.

En el checkout no se identificó un artefacto rotulado como benchmark V3.3.
Los scripts existentes en `benchmarks/` se conservan para la comparación.

## Contrato de carga de resultados

El Excel proporciona un catálogo, no predicciones, coordenadas, valores de clase,
probabilidades, rutas de archivos ni definición de esquema. Se omiten los modelos
A/B/C de ejemplo. El contrato de importación de esta POC es explícito:

```json
{
  "caseId": "ID DEL CASO ACTIVO",
  "seriesUID": "UID DE LA LÁMINA ACTIVA",
  "results": [
    { "modelId": "mitosis", "value": "SALIDA ORIGINAL DEL MODELO" }
  ]
}
```

`score` es opcional (0–1); los campos adicionales se conservan y se muestran en el
JSON detallado. Los identificadores se muestran en cada entrada del catálogo.
Los archivos se limitan a 5 MiB y se validan contra el caso y la serie activos.
El visor requiere un contexto resuelto con referencia ImagingStudy, Study UID
y Series UID. En el JSON POC, `caseId` y `seriesUID` siguen siendo obligatorios.
Si el archivo incluye `imagingStudyReference` o `studyInstanceUID`, deben
coincidir con el contexto activo. Se informa de identidad insuficiente o
incompatible antes de mostrar resultados. Estos campos describen el contrato
del visor. Los formatos de productores reales siguen pendientes de confirmación.
Las cargas viven en memoria hasta cambiar de lámina; el feedback se guarda
localmente con copia de su resultado original y se recupera al cargar ese mismo
resultado. No es persistencia clínica compartida.

Los heatmaps y candidatos se describen en el catálogo. Su representación espacial
queda pendiente hasta disponer de JSON reales y confirmar sistema de coordenadas,
referencia DICOM, resolución, clases y normalización del heatmap. Los vínculos a
Drive del Excel son ejemplos de referencia, no una integración implementada.

## Herramientas y referencias

Barra visible: desplazamiento, zoom por arrastre, acercar/alejar, ROI rectangular
y poligonal, distancia, edición y visibilidad de ROI, rotación, restauración y
exportación JSON. Se muestra escala en µm/píxel obtenida de la proyección DICOM;
el nivel de zoom no representa magnificación óptica. Las ROI exportan coordenadas
DICOM de la lámina en mm con FrameOfReferenceUID y se pierden al salir si no se
exportan. Las correcciones de ROI son independientes del resultado IA importado.

Referencias de diseño:
- OHIF: https://docs.ohif.org/user-guide/viewer/toolbar/
- ESDIP, guía de selección de sistemas: https://doi.org/10.1002/path.70103

Esta implementación toma herramientas de esas referencias; no certifica
cumplimiento ESDIP. Pendientes de validación: magnificaciones ópticas 10×/20×/40×
con metadatos del escáner, comparación simultánea, áreas, atajos y recorrido de
tejido, además del adaptador espacial para las salidas reales.

## Verificación

`node --test --test-isolation=none tests/*.test.mjs` y `npm run build`.
Prueba manual con FHIR y DICOMweb configurados: buscar y filtrar casos, abrir una
lámina, navegar, dibujar y editar ROI, medir una distancia, exportar y comprobar
coordenadas, importar un JSON del caso/serie activos, guardar feedback, recargar
y comprobar que la predicción original no cambia. Un JSON de otra lámina debe
rechazarse. Sin endpoints configurados no se ha validado este recorrido integrado.
