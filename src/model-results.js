// Catálogo transcrito de Outputs modelos (1).xlsx, filas 6–17.
export const MODEL_CATALOG = [
  ['mitosis', 'Mitosis', true],
  ['pleomorfismo', 'Pleomorfismo Nuclear', true],
  ['grado-nuclear', 'Grado Nuclear', true],
  ['invasivo', 'invasivo/no invasivo'],
  ['histologico', 'tipo histologico 3C'],
  ['tubular', 'g.h. dif. Tubular'],
  ['linfatica', 'invasion linfatica'],
  ['grado-general', 'g.h. grado general'],
  ['microcalcificaciones', 'microcalcificaciones'],
  ['necrosis', 'c.d.i necrosis'],
  ['slidechat', 'slidechat'],
].map(([id, name, candidates]) => ({
  id, name,
  input: id === 'slidechat' ? 'embeddings - consulta' : candidates ? 'WSI - embeddings' : 'embeddings',
  output: id === 'slidechat' ? 'reporte' : candidates ? 'clase - anotacion' : 'clase',
  display: id === 'slidechat' ? 'texto' : candidates ? 'clase, heatmap, candidatos' : 'clase, heatmap',
  corrections: id === 'slidechat' ? 'reporte' : candidates ? 'clase - ROI - candidatos' : 'clase, anotacion',
  format: 'json',
}));

const requiredIdentity = ['caseId', 'seriesUID'];
const studyIdentity = ['imagingStudyReference', 'studyInstanceUID'];
const hasIdentityValue = value => typeof value === 'string' && value.trim().length > 0;

export function validateResults(data, context) {
  const contextFields = [...requiredIdentity, ...studyIdentity];
  if (contextFields.some(field => !hasIdentityValue(context?.[field]))) {
    throw new Error('Identidad de la lámina sin verificar. No se pueden asociar resultados.');
  }
  const missing = requiredIdentity.filter(field => !hasIdentityValue(data?.[field]));
  if (missing.length) {
    throw new Error(`Identidad insuficiente en el JSON. Campos requeridos: ${missing.join(', ')}.`);
  }
  for (const field of contextFields) {
    if (Object.hasOwn(data, field) && data[field] !== context[field]) {
      throw new Error(`Identidad incompatible: ${field} no coincide con la lámina activa.`);
    }
  }
  if (!Array.isArray(data.results)) {
    throw new Error('Formato no admitido. El JSON POC requiere un arreglo results.');
  }
  const seen = new Set();
  for (const result of data.results) {
    if (!MODEL_CATALOG.some(m => m.id === result?.modelId) || seen.has(result.modelId)) {
      throw new Error('Modelo desconocido o duplicado. Consulte los identificadores del catálogo.');
    }
    seen.add(result.modelId);
    if (typeof result.value !== 'string' || !result.value.trim()) throw new Error('Cada resultado requiere value como texto no vacío.');
    if (result.score != null && (typeof result.score !== 'number' || !Number.isFinite(result.score) || result.score < 0 || result.score > 1)) throw new Error('score debe ser un número entre 0 y 1.');
  }
  return structuredClone(data);
}

export function renderModelResults({ container, context }) {
  const { caseId, seriesUID } = context;
  const panel = document.createElement('section');
  panel.className = 'model-panel';
  panel.innerHTML = `<h2>Resultados iniciales de IA</h2><p>El catálogo describe salidas esperadas. Cargue el JSON original para ver predicciones; las correcciones guardadas en FHIR no se incorporan aquí.</p><label>Cargar resultados JSON <input type="file" accept=".json,application/json"></label><p role="status"></p><div class="model-list"></div>`;
  const list = panel.querySelector('.model-list');
  function render(results = []) {
    list.replaceChildren();
    for (const model of MODEL_CATALOG) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      const result = results.find(r => r.modelId === model.id);
      summary.textContent = `${model.name} · ${result ? 'Resultado cargado' : 'Sin resultado'}`;
      details.append(summary);
      for (const [label, value] of Object.entries({ Identificador: model.id, Entrada: model.input, Salida: model.output, Visualización: model.display, 'Puede corregir el patólogo': model.corrections, Archivo: model.format, Ubicación: 'No informada en Excel', Espacial: 'No especificado en Excel' })) {
        const p = document.createElement('p'); p.textContent = `${label}: ${value}`; details.append(p);
      }
      if (result) {
        const p = document.createElement('p'); p.textContent = `IA original: ${result.value}${result.score == null ? '' : ` · score: ${result.score}`}`; details.append(p);
        const form = document.createElement('form');
        form.innerHTML = `<label>Feedback inicial <select required><option value="">Seleccione evaluación</option><option value="agree">De acuerdo</option><option value="partial">Parcialmente de acuerdo</option><option value="disagree">En desacuerdo</option></select></label><label>Corrección propuesta <textarea rows="2"></textarea></label><button type="submit">Guardar feedback local</button><p role="status"></p>`;
        form.addEventListener('submit', event => {
          event.preventDefault();
          const status = form.querySelector('[role=status]');
          try {
            localStorage.setItem(`wsi-initial-feedback:${caseId}:${seriesUID}:${model.id}`, JSON.stringify({ ...context, modelId: model.id, originalResult: result, agreement: form.querySelector('select').value, correction: form.querySelector('textarea').value, updatedAt: new Date().toISOString() }));
            status.textContent = 'Feedback guardado en este navegador. El resultado original permanece intacto; FHIR no se modifica.';
          } catch { status.textContent = 'No se pudo guardar el feedback local.'; }
        });
        try {
          const saved = JSON.parse(localStorage.getItem(`wsi-initial-feedback:${caseId}:${seriesUID}:${model.id}`) || 'null');
          if (saved &&
              studyIdentity.every(field => !Object.hasOwn(saved, field) || saved[field] === context[field]) &&
              JSON.stringify(saved.originalResult) === JSON.stringify(result)) {
            form.querySelector('select').value = saved.agreement;
            form.querySelector('textarea').value = saved.correction;
            form.querySelector('[role=status]').textContent = 'Feedback local recuperado para este resultado original.';
          }
        } catch { /* El formulario sigue disponible sin almacenamiento local. */ }
        details.append(form);
        const pre = document.createElement('pre'); pre.textContent = JSON.stringify(result, null, 2); details.append(pre);
      }
      list.append(details);
    }
  }
  let selection = 0;
  panel.querySelector('input').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    const current = ++selection;
    const status = panel.querySelector('[role=status]');
    render();
    status.textContent = 'Validando identidad del archivo…';
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('El archivo supera 5 MB.');
      const contents = await file.text();
      if (current !== selection) return;
      const data = validateResults(JSON.parse(contents), context);
      render(data.results);
      status.textContent = 'Resultados originales cargados en esta sesión. Los datos espaciales se muestran como JSON; requieren un adaptador de coordenadas para el overlay.';
    } catch (error) {
      if (current === selection) status.textContent = error.message;
    }
  });
  render(); container.append(panel);
}
