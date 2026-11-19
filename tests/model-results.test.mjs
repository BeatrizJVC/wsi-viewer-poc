import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = await readFile(new URL('../src/model-results.js', import.meta.url), 'utf8');
const { MODEL_CATALOG, validateResults, adaptReport, validateMaps, readResultsFiles, renderModelResults } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
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
  const read = file => readResultsFiles([file], context);
  const loaded = await read(jsonFile(payload));
  assert.equal(loaded.state, 'available');
  assert.deepEqual(loaded.results, payload.results);
  assert.equal((await read(jsonFile({ ...payload, results: [] }))).state, 'empty');
  assert.equal((await read(textFile('{'))).state, 'error');
  assert.equal((await read(jsonFile(null))).state, 'error');
  const incompatible = await read(jsonFile({ ...payload, seriesUID: '1.4.5' }));
  assert.equal(incompatible.state, 'incompatible');
  assert.deepEqual(incompatible.results, []);
  const unreadable = { size: 1, text: async () => { throw new Error('Lectura fallida'); } };
  assert.equal((await read(unreadable)).state, 'error');
  const oversized = { size: 5 * 1024 * 1024 + 1, text: async () => assert.fail('No debe intentar leer') };
  assert.match((await read(oversized)).message, /5 MiB/);
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
      after(sibling) { this.next = sibling; },
      addEventListener(name, listener) { this[name] = listener; },
      set textContent(value) { this.literal = value; dynamicNodes.push(this); },
      get textContent() { return this.literal; },
    };
  }
  const list = node('div');
  const importStatus = node('p');
  const input = node('input');
  const mapsSummary = node('div');
  const selectors = { '.maps-summary': mapsSummary, '.model-list': list, '[role=status]': importStatus, input };
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
  await choose(jsonFile(report));
  const reportCard = list.children[1].children[1];
  assert.equal(importStatus.dataset.state, 'unverified');
  assert.equal(reportCard.children[1].children[0].children[0].textContent, 'Contenido del archivo sin vincular');
  assert.ok(!reportCard.children[1].children.some(child => child.tag === 'form'));
  await choose(jsonFile({ ...payload, studyInstanceUID: '1.9' }));
  assert.equal(importStatus.dataset.state, 'incompatible');
  assert.ok(list.children.every(group => group.children.slice(1).every(card => !card.open)));
  assert.equal(importStatus.next.hidden, false);
  importStatus.next.click();
  assert.equal(importStatus.dataset.state, 'unverified');
  assert.equal(importStatus.next.hidden, true);
});

const report = { schema:'clam_ensemble.report', schema_version:'1.0', slide:{slide_id:'case-1'}, run:{run_id:'run-1'}, fields:[{path:'control.carcinoma_invasivo',status:'predicted',value:'invasivo',confidence:0.98},{path:'carcinoma_ductal_in_situ.grado_nuclear',status:'gated_off',value:'no_identificado',confidence:null},{path:'otro.campo',value:['uno','dos']}], mllm:{answer:'Texto original'} };
test('adapta CLAM sin perder gated_off, campos adicionales o MLLM', () => {
 const result=adaptReport(report, context);
 assert.equal(result.results.length,4);
 assert.equal(result.results[0].modelId,'invasivo');
 assert.equal(result.results[1].status,'gated_off');
 assert.equal(result.results[1].score,null);
 assert.equal(result.results[2].value,'uno, dos');
 assert.equal(result.results[3].modelId,'report:mllm');
 result.originalReport.fields[0].value='otra';
 assert.equal(report.fields[0].value,'invasivo');
 assert.throws(()=>adaptReport(report, {...context, caseId:'other'}));
});
const maps={schema:'clam_ensemble.maps',schema_version:'1.0',slide_id:'case-1',run_id:'run-1',coord_frame:'openslide_level0',patch_size:256,n_patches:1,coords:[[33000,100]],maps:{attention:{scores:[0.1]}}};
test('maps rechaza otra ejecución y scores desalineados; detecta desborde sin reescalar',()=>{
 assert.equal(validateMaps(maps,context,'run-1',{width:33000,height:2000}).outside,true);
 assert.throws(()=>validateMaps(maps,context,'another'));
 assert.throws(()=>validateMaps({...maps,maps:{attention:{scores:[]}}},context,'run-1'));
 assert.throws(()=>validateMaps(maps,{...context, caseId:'other'},'run-1'));
});

test('importa report y maps juntos o por separado y exige una serie explícita para asociarlos', async () => {
  const preview = await readResultsFiles([jsonFile(report), jsonFile(maps)], context);
  assert.equal(preview.state, 'unverified');
  assert.deepEqual(preview.mapInfo.layers, ['attention']);
  assert.equal(preview.report.verified, false);
  assert.equal(preview.mapInfo.verified, false);
  assert.equal(preview.report.seriesUID, undefined);

  const first = await readResultsFiles([jsonFile({ ...report, seriesUID: context.seriesUID })], context);
  const both = await readResultsFiles([jsonFile({ ...maps, seriesUID: context.seriesUID })], context,
    { width: 33000, height: 2000 }, first);
  assert.equal(both.state, 'available');
  assert.equal(both.mapInfo.outside, true);
  assert.equal(both.report.verified, true);
  assert.equal(both.mapInfo.verified, true);

  const mismatch = await readResultsFiles([jsonFile({ ...maps, run_id: 'other-run' })], context, null, first);
  assert.equal(mismatch.state, 'incompatible');
  assert.deepEqual(mismatch.results, []);
  const wrongSlide = await readResultsFiles([jsonFile({ ...report, seriesUID: '1.9' })], context);
  assert.equal(wrongSlide.state, 'incompatible');
});
