import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = await readFile(new URL('../src/model-results.js', import.meta.url), 'utf8');
const { MODEL_CATALOG, validateResults, readResultsFile, renderModelResults } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const payload = { caseId: 'case-1', seriesUID: '1.2.3', results: [{ modelId: 'mitosis', value: 'clase recibida', score: 0.8 }] };
const context = {
 caseId: 'case-1',
 imagingStudyReference: 'ImagingStudy/study-1',
 studyInstanceUID: '1.2',
 seriesUID: '1.2.3',
};
test('catálogo conserva los once modelos y excluye ejemplos', () => {
 assert.equal(MODEL_CATALOG.length, 11);
 assert.equal(MODEL_CATALOG.find(m => m.id === 'slidechat').output, 'reporte');
});
test('resultados se aíslan por caso y lámina y se copian', () => {
 const result = validateResults(payload, context);
 result.results[0].value = 'corrección';
 assert.equal(payload.results[0].value, 'clase recibida');
 assert.throws(() => validateResults(payload, {...context, caseId: 'other'}));
 assert.throws(() => validateResults(payload, {...context, seriesUID: 'other'}));
});
test('rechaza duplicados, modelos desconocidos y scores inválidos', () => {
 for (const results of [[...payload.results, ...payload.results], [{modelId:'unknown',value:'x'}], [{modelId:'mitosis',value:'x',score:2}]]) {
  assert.throws(() => validateResults({...payload, results}, context));
 }
});

test('conserva el contrato POC y verifica los identificadores de estudio declarados', () => {
 const legacy = validateResults(payload, context);
 assert.deepEqual(legacy, payload);
 assert.deepEqual(validateResults({...payload, ...context}, context), {...payload, ...context});
 assert.throws(() => validateResults({...payload, studyInstanceUID: '1.9'}, context), /incompatible: studyInstanceUID/);
 assert.throws(() => validateResults({...payload, imagingStudyReference: 'ImagingStudy/another'}, context), /incompatible: imagingStudyReference/);
});

test('identifica campos obligatorios ausentes y rechaza contexto sin resolver', () => {
 assert.throws(() => validateResults({...payload, seriesUID: undefined}, context), /insuficiente.*seriesUID/);
 assert.throws(() => validateResults({...payload, caseId: ''}, context), /insuficiente.*caseId/);
 assert.throws(() => validateResults(payload, {...context, studyInstanceUID: undefined}), /sin verificar/);
 assert.throws(() => validateResults({...payload, results: undefined}, context), /Formato no admitido/);
});

const textFile = text => ({ size: Buffer.byteLength(text), text: async () => text });
const jsonFile = value => textFile(JSON.stringify(value));

test('distingue archivo disponible, vacío, inválido, incompatible y error de lectura', async () => {
  assert.deepEqual(await readResultsFile(jsonFile(payload), context), {
    state: 'available', results: payload.results,
  });
  assert.deepEqual(await readResultsFile(jsonFile({ ...payload, results: [] }), context), {
    state: 'empty', results: [],
  });
  assert.equal((await readResultsFile(textFile('{'), context)).state, 'error');
  assert.equal((await readResultsFile(jsonFile(null), context)).state, 'error');
  const incompatible = await readResultsFile(jsonFile({ ...payload, seriesUID: '1.4.5' }), context);
  assert.equal(incompatible.state, 'incompatible');
  assert.deepEqual(incompatible.results, []);
  const unreadable = { size: 1, text: async () => { throw new Error('Lectura fallida'); } };
  assert.equal((await readResultsFile(unreadable, context)).state, 'error');
  const oversized = { size: 5 * 1024 * 1024 + 1, text: async () => assert.fail('No debe intentar leer') };
  assert.match((await readResultsFile(oversized, context)).message, /5 MiB/);
});

test('monta las familias y muestra SlideChat como texto; la última selección prevalece', async t => {
  const dynamicNodes = [];
  function node(tag) {
    return {
      tag,
      children: [],
      dataset: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute() {},
      addEventListener(name, listener) { this[name] = listener; },
      set textContent(value) { this.literal = value; dynamicNodes.push(this); },
      get textContent() { return this.literal; },
    };
  }
  const list = node('div');
  const importStatus = node('p');
  const input = node('input');
  const selectors = { '.model-list': list, '[role=status]': importStatus, input };
  const container = node('root');
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      return Object.assign(node(tag), {
        querySelector(selector) {
          if (this.tag === 'form') return node(selector);
          return selectors[selector];
        },
      });
    },
  };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });

  renderModelResults({ container, context });
  assert.deepEqual(list.children.map(group => group.children[0].textContent),
    ['Espaciales', 'Clasificadores', 'Texto']);
  assert.deepEqual(list.children.map(group => group.children.length - 1), [3, 7, 1]);
  assert.equal(importStatus.textContent, 'Sin resultado');

  const choose = file => input.change({ target: { files: [file] } });
  let finishFirstRead;
  const first = choose({ size: 1, text: () => new Promise(resolve => { finishFirstRead = resolve; }) });
  const message = 'Primera línea\n<img src=x onerror="alert(1)">';
  await choose(jsonFile({
    ...payload,
    results: [{ modelId: 'slidechat', value: message }],
  }));
  finishFirstRead(JSON.stringify(payload));
  await first;
  assert.equal(importStatus.textContent, 'Disponible');
  const slideChat = list.children[2].children[1];
  assert.ok(slideChat.open);
  const [prediction, review, technical] = slideChat.children[1].children;
  assert.equal(prediction.children[0].textContent, 'Predicción IA');
  assert.equal(prediction.children[1].tag, 'p');
  assert.equal(prediction.children[1].textContent, message);
  assert.equal(prediction.children.length, 2);
  assert.equal(review.tag, 'form');
  assert.equal(technical.children[0].textContent, 'Información técnica');
  assert.ok(!dynamicNodes.some(item => item.textContent?.startsWith('Score del modelo')));
  assert.equal(list.children[0].children[1].children[0].children[1].textContent, 'Sin resultado');

  await choose(jsonFile({ ...payload, results: [{ ...payload.results[0], score: 0 }] }));
  assert.ok(dynamicNodes.some(item => item.textContent === 'Score del modelo: 0'));
  await choose(jsonFile({ ...payload, studyInstanceUID: '1.9' }));
  assert.equal(importStatus.dataset.state, 'incompatible');
  assert.ok(list.children.every(group => group.children.slice(1).every(card => !card.open)));
});
