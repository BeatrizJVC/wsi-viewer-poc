import assert from 'node:assert/strict';
import test from 'node:test';
import { createWsiViewer, getLiveInstanceCount } from '../src/wsi/create-wsi-viewer.js';

const STUDY = '1.2.3';
const SERIES = '1.2.3.4';

function rawInstance(flavor, columns = 1000, rows = 800) {
  return {
    flavor, columns, rows,
    bulk: { BulkDataURI: 'http://localhost:8042/dicom-web/studies/1.2.3/bulk' },
  };
}

function fakeDmv({ renderError, cleanupError, setTargetError } = {}) {
  const viewers = [];
  class VLWholeSlideMicroscopyImage {
    constructor({ metadata }) {
      if (metadata.flavor === 'bad') throw new Error('invalid instance');
      this.ImageType = ['ORIGINAL', 'PRIMARY', metadata.flavor];
      this.TotalPixelMatrixColumns = metadata.columns;
      this.TotalPixelMatrixRows = metadata.rows;
    }
  }
  class VolumeImageViewer {
    constructor(options) {
      this.options = options;
      this.renderCalls = [];
      this.cleanupCalls = 0;
      this.targets = [];
      this.map = {
        setTarget: target => {
          this.targets.push(target);
          if (setTargetError) throw setTargetError;
        },
      };
      viewers.push(this);
    }
    render(options) {
      this.renderCalls.push(options);
      if (renderError) throw renderError;
    }
    getMap() { return this.map; }
    cleanup() {
      this.cleanupCalls++;
      if (cleanupError) throw cleanupError;
    }
  }
  return { viewers, dmv: { metadata: { VLWholeSlideMicroscopyImage }, viewer: { VolumeImageViewer } } };
}

function deferredClient(metadata) {
  let resolve;
  const calls = [];
  const client = {
    retrieveSeriesMetadata(args) {
      calls.push(args);
      return new Promise(r => { resolve = () => r(metadata); });
    },
  };
  return { client, calls, resolve: () => resolve() };
}

const immediateClient = metadata => ({ retrieveSeriesMetadata: async () => metadata });

function baseOptions(dmv, client, extra = {}) {
  return {
    dmv, client, container: { id: 'container' },
    studyInstanceUID: STUDY, seriesInstanceUID: SERIES, dicomWebUrl: '/dicom-web', ...extra,
  };
}

test('crea y renderiza una vez la pirámide VOLUME/THUMBNAIL con BulkDataURI reescritos', async () => {
  const { dmv, viewers } = fakeDmv();
  const metadata = [rawInstance('VOLUME', 40000, 30000), rawInstance('LABEL'), rawInstance('bad'), rawInstance('THUMBNAIL')];
  const statuses = [];
  const handle = await createWsiViewer(baseOptions(dmv, immediateClient(metadata), { onStatus: s => statuses.push(s) }));
  assert.equal(viewers.length, 1);
  const [viewer] = viewers;
  assert.equal(viewer.renderCalls.length, 1);
  assert.deepEqual(viewer.renderCalls[0], { container: { id: 'container' } });
  assert.equal(viewer.options.skipThumbnails, true);
  assert.equal(typeof viewer.options.errorInterceptor, 'function');
  assert.deepEqual(viewer.options.metadata.map(i => i.ImageType[2]), ['VOLUME', 'THUMBNAIL']);
  assert.deepEqual(handle.dimensions, { width: 40000, height: 30000 });
  assert.equal(metadata[0].bulk.BulkDataURI, '/dicom-web/studies/1.2.3/bulk');
  assert.ok(statuses.length > 0);
  assert.equal(getLiveInstanceCount(), 1);
  handle.destroy();
  assert.equal(getLiveInstanceCount(), 0);
});

test('una señal ya abortada no consulta DICOMweb ni crea el visor', async () => {
  const { dmv, viewers } = fakeDmv();
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const client = { retrieveSeriesMetadata: async () => { called = true; return []; } };
  await assert.rejects(createWsiViewer(baseOptions(dmv, client, { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(called, false);
  assert.equal(viewers.length, 0);
  assert.equal(getLiveInstanceCount(), 0);
});

test('abortar mientras llega la metadata impide construir y renderizar el visor', async () => {
  const { dmv, viewers } = fakeDmv();
  const controller = new AbortController();
  const { client, calls, resolve } = deferredClient([rawInstance('VOLUME')]);
  const pending = createWsiViewer(baseOptions(dmv, client, { signal: controller.signal }));
  assert.equal(calls.length, 1);
  controller.abort();
  resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(viewers.length, 0);
  assert.equal(getLiveInstanceCount(), 0);
});

test('destroy es idempotente: cleanup y desvinculación ocurren una sola vez', async () => {
  const { dmv, viewers } = fakeDmv();
  const handle = await createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')])));
  assert.deepEqual(handle.destroy(), { fullCleanup: true });
  assert.deepEqual(handle.destroy(), { fullCleanup: false });
  handle.destroy();
  assert.equal(viewers[0].cleanupCalls, 1);
  assert.deepEqual(viewers[0].targets, [undefined]);
  assert.equal(handle.destroyed, true);
  assert.equal(getLiveInstanceCount(), 0);
});

test('destruir una instancia con otra viva no llama a cleanup (terminateAllWebWorkers)', async () => {
  const { dmv, viewers } = fakeDmv();
  const a = await createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')])));
  const b = await createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')])));
  assert.equal(getLiveInstanceCount(), 2);

  assert.deepEqual(a.destroy(), { fullCleanup: false });
  assert.equal(viewers[0].cleanupCalls, 0);
  assert.deepEqual(viewers[0].targets, [undefined]);
  assert.equal(viewers[1].cleanupCalls, 0);
  assert.deepEqual(viewers[1].targets, []);
  assert.equal(getLiveInstanceCount(), 1);

  assert.deepEqual(b.destroy(), { fullCleanup: true });
  assert.equal(viewers[1].cleanupCalls, 1);
  assert.equal(getLiveInstanceCount(), 0);
});

test('una instancia aún cargando metadata no cuenta como viva hasta renderizar', async () => {
  const { dmv, viewers } = fakeDmv();
  const a = await createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')])));
  const { client, resolve } = deferredClient([rawInstance('VOLUME')]);
  const pendingB = createWsiViewer(baseOptions(dmv, client));
  assert.deepEqual(a.destroy(), { fullCleanup: true });
  resolve();
  const b = await pendingB;
  assert.equal(viewers[1].renderCalls.length, 1);
  assert.equal(getLiveInstanceCount(), 1);
  b.destroy();
  assert.equal(getLiveInstanceCount(), 0);
});

test('errorInterceptor devuelve el mismo error, cuenta errores y aísla fallos de onError', async () => {
  const { dmv, viewers } = fakeDmv();
  const received = [];
  const handle = await createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')]), {
    onError: (error, count) => { received.push([error.message, count]); if (count === 2) throw new Error('callback bug'); },
  }));
  const intercept = viewers[0].options.errorInterceptor;
  const e1 = new Error('tile 1');
  const e2 = new Error('tile 2');
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(intercept(e1), e1);
    assert.equal(intercept(e2), e2);
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(received, [['tile 1', 1], ['tile 2', 2]]);
  assert.equal(handle.errorCount, 2);
  handle.destroy();
  const e3 = new Error('late');
  assert.equal(intercept(e3), e3);
  assert.equal(handle.errorCount, 2);
});

test('sin instancias VOLUME/THUMBNAIL falla sin crear visor ni instancia viva', async () => {
  const { dmv, viewers } = fakeDmv();
  await assert.rejects(
    createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('LABEL')]))),
    /No se encontraron instancias VOLUME\/THUMBNAIL/
  );
  assert.equal(viewers.length, 0);
  assert.equal(getLiveInstanceCount(), 0);
});

test('valida argumentos obligatorios', async () => {
  const { dmv } = fakeDmv();
  await assert.rejects(createWsiViewer(baseOptions(undefined, immediateClient([]))), TypeError);
  await assert.rejects(createWsiViewer(baseOptions(dmv, {})), TypeError);
  await assert.rejects(createWsiViewer(baseOptions(dmv, immediateClient([]), { container: null })), TypeError);
  await assert.rejects(createWsiViewer(baseOptions(dmv, immediateClient([]), { seriesInstanceUID: '' })), TypeError);
});

test('si render falla: propaga el error, limpia la instancia y no cuenta errores tardíos', async () => {
  const renderError = new Error('render failed');
  const { dmv, viewers } = fakeDmv({ renderError });
  const received = [];
  await assert.rejects(
    createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')]), { onError: e => received.push(e) })),
    error => error === renderError && error.cleanupErrors === undefined
  );
  const [viewer] = viewers;
  assert.equal(getLiveInstanceCount(), 0);
  assert.equal(viewer.cleanupCalls, 1, 'era la única instancia: limpieza completa');
  assert.deepEqual(viewer.targets, [undefined]);
  const late = new Error('late tile error');
  assert.equal(viewer.options.errorInterceptor(late), late);
  assert.deepEqual(received, []);
});

test('si render falla con otra instancia viva no se llama a cleanup global', async () => {
  const okDmv = fakeDmv();
  const alive = await createWsiViewer(baseOptions(okDmv.dmv, immediateClient([rawInstance('VOLUME')])));
  const { dmv, viewers } = fakeDmv({ renderError: new Error('render failed') });
  await assert.rejects(createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')]))), /render failed/);
  assert.equal(viewers[0].cleanupCalls, 0);
  assert.deepEqual(viewers[0].targets, [undefined]);
  assert.equal(getLiveInstanceCount(), 1);
  assert.deepEqual(alive.destroy(), { fullCleanup: true });
  assert.equal(getLiveInstanceCount(), 0);
});

test('si render falla y la limpieza secundaria también, se conserva el error original', async () => {
  const renderError = new Error('render failed');
  const cleanupError = new Error('cleanup failed');
  const setTargetError = new Error('setTarget failed');
  const { dmv } = fakeDmv({ renderError, cleanupError, setTargetError });
  await assert.rejects(
    createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')]))),
    error => error === renderError &&
      error.cleanupErrors.length === 2 &&
      error.cleanupErrors[0] === cleanupError &&
      error.cleanupErrors[1] === setTargetError
  );
  assert.equal(getLiveInstanceCount(), 0);
});

test('render que lanza un valor no objeto se propaga sin modificar', async () => {
  const { dmv } = fakeDmv({ renderError: 'plain string failure', setTargetError: new Error('setTarget failed') });
  await assert.rejects(
    createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')]))),
    error => error === 'plain string failure'
  );
  assert.equal(getLiveInstanceCount(), 0);
});

function rejectingClient() {
  let reject;
  const client = {
    retrieveSeriesMetadata: () => new Promise((_resolve, r) => { reject = r; }),
  };
  return { client, reject: error => reject(error) };
}

test('error de red después de abortar se informa como AbortError', async () => {
  const { dmv, viewers } = fakeDmv();
  const controller = new AbortController();
  const { client, reject } = rejectingClient();
  const pending = createWsiViewer(baseOptions(dmv, client, { signal: controller.signal }));
  controller.abort();
  reject(new TypeError('Failed to fetch'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(viewers.length, 0);
  assert.equal(getLiveInstanceCount(), 0);
});

test('error de red sin cancelación se propaga intacto', async () => {
  const { dmv, viewers } = fakeDmv();
  const controller = new AbortController();
  const { client, reject } = rejectingClient();
  const networkError = new TypeError('Failed to fetch');
  const pending = createWsiViewer(baseOptions(dmv, client, { signal: controller.signal }));
  reject(networkError);
  await assert.rejects(pending, error => error === networkError);
  assert.equal(controller.signal.aborted, false);
  assert.equal(viewers.length, 0);
  assert.equal(getLiveInstanceCount(), 0);
});

test('destroy con fallo aislado de setTarget: cleanup se ejecuta, la instancia queda destruida y el contador correcto', async () => {
  const setTargetError = new Error('setTarget failed');
  const { dmv, viewers } = fakeDmv({ setTargetError });
  const handle = await createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')])));
  assert.equal(getLiveInstanceCount(), 1);

  assert.throws(() => handle.destroy(), error => error === setTargetError && error.cleanupErrors === undefined);
  assert.equal(viewers[0].cleanupCalls, 1, 'cleanup se ejecutó antes de desvincular');
  assert.deepEqual(viewers[0].targets, [undefined]);
  assert.equal(handle.destroyed, true);
  assert.equal(getLiveInstanceCount(), 0);

  assert.deepEqual(handle.destroy(), { fullCleanup: false }, 'idempotente: no reintenta ni lanza');
  assert.equal(viewers[0].cleanupCalls, 1);
  assert.equal(getLiveInstanceCount(), 0);
});

test('destroy con cleanup y setTarget fallando: se lanza el error de cleanup y el de setTarget queda adjunto', async () => {
  const cleanupError = new Error('cleanup failed');
  const setTargetError = new Error('setTarget failed');
  const { dmv, viewers } = fakeDmv({ cleanupError, setTargetError });
  const handle = await createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')])));
  assert.throws(
    () => handle.destroy(),
    error => error === cleanupError && error.cleanupErrors.length === 1 && error.cleanupErrors[0] === setTargetError
  );
  assert.deepEqual(viewers[0].targets, [undefined], 'setTarget se intentó pese al fallo de cleanup');
  assert.equal(handle.destroyed, true);
  assert.equal(getLiveInstanceCount(), 0);
});

test('destroy con fallo de setTarget y otra instancia viva no llama a cleanup global', async () => {
  const okDmv = fakeDmv();
  const alive = await createWsiViewer(baseOptions(okDmv.dmv, immediateClient([rawInstance('VOLUME')])));
  const setTargetError = new Error('setTarget failed');
  const { dmv, viewers } = fakeDmv({ setTargetError });
  const handle = await createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')])));
  assert.equal(getLiveInstanceCount(), 2);
  assert.throws(() => handle.destroy(), error => error === setTargetError);
  assert.equal(viewers[0].cleanupCalls, 0);
  assert.equal(handle.destroyed, true);
  assert.equal(getLiveInstanceCount(), 1);
  assert.deepEqual(alive.destroy(), { fullCleanup: true });
  assert.equal(getLiveInstanceCount(), 0);
});

test('destroy con error principal no objeto informa los secundarios en consola', async t => {
  const setTargetError = new Error('setTarget failed');
  const { dmv } = fakeDmv({ cleanupError: 'plain cleanup failure', setTargetError });
  const handle = await createWsiViewer(baseOptions(dmv, immediateClient([rawInstance('VOLUME')])));
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  assert.throws(() => handle.destroy(), error => error === 'plain cleanup failure');
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0][1], [setTargetError]);
  assert.equal(getLiveInstanceCount(), 0);
});
