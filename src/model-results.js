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

const REPORT_FIELDS = {
  'control.carcinoma_invasivo': 'invasivo',
  'tipo_histologico': 'histologico',
  'grado_histologico.diferenciacion_tubular': 'tubular',
  'grado_histologico.pleomorfismo_nuclear': 'pleomorfismo',
  'grado_histologico.tasa_mitotica': 'mitosis',
  'grado_histologico.grado_general': 'grado-general',
  'carcinoma_ductal_in_situ.grado_nuclear': 'grado-nuclear',
  'carcinoma_ductal_in_situ.necrosis': 'necrosis',
  'invasion_linfovascular': 'linfatica',
  'microcalcificaciones': 'microcalcificaciones',
};

function verifyClamIdentity(data, slideId, context) {
  if (!hasIdentityValue(String(slideId ?? '')) || String(slideId) !== context.caseId) {
    throw new IncompatibleIdentity('El slide_id no coincide con el caso activo.');
  }
  for (const field of [...requiredIdentity, ...studyIdentity]) {
    if (Object.hasOwn(data, field) && data[field] !== context[field]) {
      throw new IncompatibleIdentity(`Identidad incompatible: ${field} no coincide con la lámina activa.`);
    }
  }
  return data.seriesUID === context.seriesUID && hasIdentityValue(context.seriesUID);
}

export function adaptReport(data, context) {
  if (data?.schema !== 'clam_ensemble.report') {
    return { ...validateResults(data, context), verified: true };
  }
  if (data.schema_version !== '1.0' || !Array.isArray(data.fields)) {
    throw new Error('El report debe ser versión 1.0 y contener fields.');
  }
  const verified = verifyClamIdentity(data, data.slide?.slide_id, context);
  const seen = new Set();
  const results = data.fields.map(field => {
    if (typeof field?.path !== 'string' || !field.path || seen.has(field.path)) throw new Error('El report contiene campos inválidos o duplicados.');
    seen.add(field.path);
    if (field.confidence != null && (typeof field.confidence !== 'number' || !Number.isFinite(field.confidence) || field.confidence < 0 || field.confidence > 1)) throw new Error('Confianza inválida en el report.');
    return { modelId: Object.hasOwn(REPORT_FIELDS, field.path) ? REPORT_FIELDS[field.path] : `report:${field.path}`, label: field.path,
      value: Array.isArray(field.value) ? field.value.join(', ') : String(field.value ?? 'Sin valor'),
      score: field.confidence, status: field.status, originalField: structuredClone(field) };
  });
  if (typeof data.mllm?.answer === 'string' && data.mllm.answer.trim()) {
    results.push({ modelId: 'report:mllm', label: 'Síntesis MLLM del report', value: data.mllm.answer, originalField: structuredClone(data.mllm) });
  }
  return { verified, results, runId: data.run?.run_id, originalReport: structuredClone(data) };
}

export function validateMaps(data, context, reportRunId, dimensions) {
  if (data?.schema !== 'clam_ensemble.maps' || data.schema_version !== '1.0') {
    throw new Error('El maps debe ser versión 1.0.');
  }
  const verified = verifyClamIdentity(data, data.slide_id, context);
  if (reportRunId && data.run_id !== reportRunId) {
    throw new IncompatibleIdentity('El report y el maps pertenecen a ejecuciones diferentes (run_id).');
  }
  if (!Array.isArray(data.coords) || !data.coords.length || data.n_patches !== data.coords.length || !Number.isFinite(data.patch_size) || data.patch_size <= 0 || !data.maps || typeof data.maps !== 'object' || Array.isArray(data.maps)) throw new Error('Estructura de mapas o cantidad de patches inválida.');
  let maxX = 0, maxY = 0;
  for (const coord of data.coords) {
    if (!Array.isArray(coord) || coord.length !== 2 || coord.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Coordenadas inválidas.');
    maxX = Math.max(maxX, coord[0] + data.patch_size); maxY = Math.max(maxY, coord[1] + data.patch_size);
  }
  for (const layer of Object.values(data.maps)) {
    if (!Array.isArray(layer?.scores) || layer.scores.length !== data.coords.length || layer.scores.some(n => !Number.isFinite(n))) throw new Error('Los scores de cada mapa deben coincidir con sus patches.');
  }
  return { verified, runId: data.run_id, count: data.coords.length, layers: Object.keys(data.maps), coordFrame: data.coord_frame,
    extent: [maxX, maxY], outside: Boolean(dimensions && (maxX > dimensions.width || maxY > dimensions.height)) };
}

async function parseResultsFile(file) {
  if (file.size > 5 * 1024 * 1024) throw new Error('El archivo supera 5 MiB.');
  const contents = await file.text();
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error('El archivo contiene JSON inválido.');
  }
}

export async function readResultsFiles(files, context, dimensions, previous = {}) {
  try {
    let { report, maps } = previous;
    const incoming = new Set();
    for (const data of await Promise.all(files.map(parseResultsFile))) {
      const type = data?.schema === 'clam_ensemble.maps' ? 'maps' : 'report';
      if (incoming.has(type)) throw new Error('Seleccione como máximo un report y un maps.');
      incoming.add(type);
      if (type === 'maps') maps = data;
      else report = adaptReport(data, context);
    }
    const mapInfo = maps ? validateMaps(maps, context, report?.runId, dimensions) : null;
    const results = report?.results ?? [];
    const unverified = report?.verified === false || mapInfo?.verified === false;
    return {
      state: unverified ? 'unverified' : results.length || mapInfo ? 'available' : 'empty',
      message: unverified ? 'Hay archivos sin seriesUID. Se muestran para inspección sin vincularlos a la lámina.' : undefined,
      results, report, maps, mapInfo,
    };
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
  unverified: 'Lámina sin verificar',
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
  if (!model.format) {
    details.append(element('pre', JSON.stringify(result, null, 2)));
    return details;
  }
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

function renderModel(model, result, context, open, verified) {
  const details = element('details', undefined, 'model-card');
  details.open = open;
  const summary = element('summary');
  let label = 'Sin resultado';
  if (result) {
    label = result.status === 'gated_off' ? 'No ejecutado' : verified ? 'Disponible' : 'Sin verificar';
  }
  summary.append(element('span', model.name),
    element('span', label, label === 'Disponible' ? 'model-badge is-available' : 'model-badge'));
  details.append(summary);
  const body = element('div', undefined, 'model-card-body');
  if (result) {
    const prediction = element('section', undefined, 'model-prediction');
    prediction.append(element('h4', verified ? 'Predicción IA' : 'Contenido del archivo sin vincular'),
      element('p', result.value, 'model-value'));
    if (result.originalField?.probabilities) {
      prediction.append(element('pre', 'Probabilidades originales:\n' +
        JSON.stringify(result.originalField.probabilities, null, 2), 'model-probabilities'));
    }
    if (result.score != null) prediction.append(element('p', `Score del modelo: ${result.score}`, 'model-note'));
    if (model.family === 'spatial') {
      prediction.append(element('p', 'La visualización espacial requiere un formato de coordenadas compatible.', 'model-note'));
    }
    body.append(prediction);
    if (verified) body.append(renderReview(context, result));
  }
  body.append(renderTechnicalInfo(model, result));
  details.append(body);
  return details;
}

export function renderModelResults({ container, context, dimensions }) {
  const panel = element('section', undefined, 'model-panel');
  panel.setAttribute('aria-label', 'Resultados IA');
  panel.innerHTML = `
    <header class="model-panel-header">
      <h2>Resultados IA</h2>
      <label>Cargar resultados, report o maps JSON <input type="file" multiple accept=".json,application/json"></label>
      <p class="model-load-status" role="status"></p>
    </header>
    <div class="maps-summary"></div>
    <div class="model-list"></div>`;
  const list = panel.querySelector('.model-list');
  const mapsSummary = panel.querySelector('.maps-summary');
  const status = panel.querySelector('[role=status]');
  const restore = element('button', 'Volver a la carga anterior');
  restore.type = 'button';
  status.after(restore);
  let selection = 0;
  let loaded;
  restore.addEventListener('click', () => render(loaded));
  function render({ state, message, results = [], report, mapInfo }) {
    restore.hidden = !loaded || (state !== 'error' && state !== 'incompatible');
    status.dataset.state = state;
    status.textContent = message ? `${loadLabels[state]} · ${message}` : loadLabels[state];
    mapsSummary.replaceChildren();
    if (mapInfo) {
      const layers = element('ul');
      layers.append(...mapInfo.layers.map(name => element('li', name)));
      mapsSummary.append(
        element('h3', mapInfo.verified ? 'Capas del archivo' : 'Capas del archivo sin vincular'),
        element('p', `${mapInfo.count} patches · ${mapInfo.coordFrame ?? 'Marco sin declarar'}`),
        layers,
        element('p', mapInfo.outside
          ? `Overlay bloqueado: extensión ${mapInfo.extent.join(' × ')} frente a WSI ${dimensions.width} × ${dimensions.height}.`
          : 'Overlay pendiente de verificar la transformación a DICOM.', 'model-note'),
      );
    }
    const byModel = new Map(results.map(result => [result.modelId, result]));
    const additional = results
      .filter(result => !MODEL_CATALOG.some(model => model.id === result.modelId))
      .map(result => ({ id: result.modelId, name: result.label, family: 'additional' }));
    const models = [...MODEL_CATALOG, ...additional];
    const groups = additional.length ? [...families, ['additional', 'Otros campos del report']] : families;
    const firstAvailable = models.find(model => byModel.has(model.id));
    list.replaceChildren(...groups.map(([family, label]) => {
      const group = element('section', undefined, 'model-family');
      group.append(element('h3', label));
      for (const model of models.filter(item => item.family === family)) {
        group.append(renderModel(model, byModel.get(model.id), context, model === firstAvailable, report?.verified !== false));
      }
      return group;
    }));
  }

  panel.querySelector('input').addEventListener('change', async event => {
    const files = Array.from(event.target.files);
    if (!files.length) return;
    event.target.value = '';
    const current = ++selection;
    render({ state: 'loading' });
    const outcome = await readResultsFiles(files, context, dimensions, loaded);
    if (current === selection) {
      if (outcome.state !== 'error' && outcome.state !== 'incompatible') loaded = outcome;
      render(outcome);
    }
  });
  render({ state: 'empty' });
  container.append(panel);
}
