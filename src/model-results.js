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
  id, name: id === 'slidechat' ? 'SlideChat' : name,
  family: id === 'slidechat' ? 'text' : candidates ? 'spatial' : 'classifier',
  input: id === 'slidechat' ? 'embeddings - consulta' : candidates ? 'WSI - embeddings' : 'embeddings',
  output: id === 'slidechat' ? 'reporte' : candidates ? 'clase - anotacion' : 'clase',
  display: id === 'slidechat' ? 'texto' : candidates ? 'clase, heatmap, candidatos' : 'clase, heatmap',
  corrections: id === 'slidechat' ? 'reporte' : candidates ? 'clase - ROI - candidatos' : 'clase, anotacion',
  format: 'json',
}));

const requiredIdentity = ['caseId', 'seriesUID'];
const studyIdentity = ['imagingStudyReference', 'studyInstanceUID'];
const hasIdentityValue = value => typeof value === 'string' && value.trim().length > 0;

class IncompatibleIdentity extends Error {}

export function validateResults(data, context) {
  const contextFields = [...requiredIdentity, ...studyIdentity];
  if (contextFields.some(field => !hasIdentityValue(context?.[field]))) {
    throw new IncompatibleIdentity('Identidad de la lámina sin verificar. No se pueden asociar resultados.');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('El archivo debe contener un objeto JSON.');
  }
  const missing = requiredIdentity.filter(field => !hasIdentityValue(data?.[field]));
  if (missing.length) {
    throw new IncompatibleIdentity(`Identidad insuficiente en el JSON. Campos requeridos: ${missing.join(', ')}.`);
  }
  for (const field of contextFields) {
    if (Object.hasOwn(data, field) && data[field] !== context[field]) {
      throw new IncompatibleIdentity(`Identidad incompatible: ${field} no coincide con la lámina activa.`);
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

export async function readResultsFile(file, context) {
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('El archivo supera 5 MiB.');
    const contents = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error('El archivo contiene JSON inválido.');
    }
    const results = validateResults(parsed, context).results;
    return { state: results.length ? 'available' : 'empty', results };
  } catch (error) {
    return {
      state: error instanceof IncompatibleIdentity ? 'incompatible' : 'error',
      message: error.message,
      results: [],
    };
  }
}

const families = [
  ['spatial', 'Espaciales'],
  ['classifier', 'Clasificadores'],
  ['text', 'Texto'],
];

const loadLabels = {
  empty: 'Sin resultado',
  loading: 'Validando archivo',
  available: 'Disponible',
  error: 'Error',
  incompatible: 'Incompatible',
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderTechnicalInfo(model, result) {
  const details = element('details', undefined, 'model-technical');
  details.append(element('summary', 'Información técnica'));
  const fields = element('dl');
  for (const [label, value] of [
    ['Identificador', model.id],
    ['Entrada', model.input],
    ['Salida esperada', model.output],
    ['Visualización prevista', model.display],
    ['Revisión prevista', model.corrections],
    ['Extensión', `.${model.format}`],
    ['Ubicación', 'No informada en Excel'],
    ['Referencia espacial', 'No especificada en Excel'],
  ]) {
    fields.append(element('dt', label), element('dd', value));
  }
  details.append(fields);
  if (result) details.append(element('pre', JSON.stringify(result, null, 2)));
  return details;
}

function renderReview(context, result) {
  const form = element('form', undefined, 'model-review');
  form.innerHTML = `
    <h4>Revisión del patólogo</h4>
    <label>Evaluación
      <select required>
        <option value="">Seleccione evaluación</option>
        <option value="agree">De acuerdo</option>
        <option value="partial">Parcialmente de acuerdo</option>
        <option value="disagree">En desacuerdo</option>
      </select>
    </label>
    <label>Corrección propuesta <textarea rows="2"></textarea></label>
    <button type="submit">Guardar revisión local</button>
    <p class="model-note">Se guarda en este navegador.</p>
    <p role="status"></p>`;
  const agreement = form.querySelector('select');
  const correction = form.querySelector('textarea');
  const status = form.querySelector('[role=status]');
  const key = `wsi-initial-feedback:${context.caseId}:${context.seriesUID}:${result.modelId}`;
  form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      localStorage.setItem(key, JSON.stringify({
        ...context,
        modelId: result.modelId,
        originalResult: result,
        agreement: agreement.value,
        correction: correction.value,
        updatedAt: new Date().toISOString(),
      }));
      status.textContent = 'Revisión guardada en este navegador.';
    } catch {
      status.textContent = 'No se pudo guardar la revisión local.';
    }
  });
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved &&
        studyIdentity.every(field => !Object.hasOwn(saved, field) || saved[field] === context[field]) &&
        JSON.stringify(saved.originalResult) === JSON.stringify(result)) {
      agreement.value = saved.agreement;
      correction.value = saved.correction;
      status.textContent = 'Revisión local recuperada para esta predicción.';
    }
  } catch { /* El formulario sigue disponible sin almacenamiento local. */ }
  return form;
}

function renderModel(model, result, context, open) {
  const details = element('details', undefined, 'model-card');
  details.open = open;
  const summary = element('summary');
  summary.append(
    element('span', model.name),
    element('span', result ? 'Disponible' : 'Sin resultado',
      result ? 'model-badge is-available' : 'model-badge'),
  );
  details.append(summary);
  const body = element('div', undefined, 'model-card-body');
  if (result) {
    const prediction = element('section', undefined, 'model-prediction');
    prediction.append(element('h4', 'Predicción IA'), element('p', result.value, 'model-value'));
    if (result.score != null) prediction.append(element('p', `Score del modelo: ${result.score}`, 'model-note'));
    if (model.family === 'spatial') {
      prediction.append(element('p', 'La visualización espacial requiere un formato de coordenadas compatible.', 'model-note'));
    }
    body.append(prediction, renderReview(context, result));
  }
  body.append(renderTechnicalInfo(model, result));
  details.append(body);
  return details;
}

export function renderModelResults({ container, context }) {
  const panel = element('section', undefined, 'model-panel');
  panel.setAttribute('aria-label', 'Resultados IA');
  panel.innerHTML = `
    <header class="model-panel-header">
      <h2>Resultados IA</h2>
      <label>Cargar resultados JSON <input type="file" accept=".json,application/json"></label>
      <p class="model-load-status" role="status"></p>
    </header>
    <div class="model-list"></div>`;
  const list = panel.querySelector('.model-list');
  const status = panel.querySelector('[role=status]');
  function render({ state, message, results = [] }) {
    status.dataset.state = state;
    status.textContent = message ? `${loadLabels[state]} · ${message}` : loadLabels[state];
    const byModel = new Map(results.map(result => [result.modelId, result]));
    const firstAvailable = MODEL_CATALOG.find(model => byModel.has(model.id));
    list.replaceChildren(...families.map(([family, label]) => {
      const group = element('section', undefined, 'model-family');
      group.append(element('h3', label));
      for (const model of MODEL_CATALOG.filter(item => item.family === family)) {
        group.append(renderModel(model, byModel.get(model.id), context, model === firstAvailable));
      }
      return group;
    }));
  }

  let selection = 0;
  panel.querySelector('input').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = '';
    const current = ++selection;
    render({ state: 'loading' });
    const outcome = await readResultsFile(file, context);
    if (current === selection) render(outcome);
  });
  render({ state: 'empty' });
  container.append(panel);
}
