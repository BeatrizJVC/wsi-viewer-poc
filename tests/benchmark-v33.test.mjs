import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const modules = new Map();
async function moduleURL(name) {
  if (modules.has(name)) return modules.get(name);
  let source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  for (const m of [...source.matchAll(/from '(\.\/[^']+)'/g)]) source = source.replace(m[0], `from '${await moduleURL(m[1].slice(2))}'`);
  source = source.replace(/from '(ol\/[^']+)'/g, (_, s) => `from '${import.meta.resolve(s)}'`);
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  modules.set(name, url); return url;
}
const core = await import(await moduleURL('benchmark-v33-core.js'));
const { createSession, instrumentClient, captureTarget, matchesFrame } = await import(await moduleURL('benchmark-v33-session.js'));
const { measureStep, defaults, executeProtocol, installBenchmarkV33 } = await import(await moduleURL('benchmark-v33.js'));
const lock = await import(await moduleURL('benchmark-run-lock.js'));
class Emitter {
  handlers = new Map();
  on(k, f) { if (!this.handlers.has(k)) this.handlers.set(k, new Set()); this.handlers.get(k).add(f); }
  un(k, f) { this.handlers.get(k)?.delete(f); }
  emit(k, e = {}) { for (const f of this.handlers.get(k) ?? []) f(e); }
  addEventListener(k, f) { this.on(k, f); }
  removeEventListener(k, f) { this.un(k, f); }
  dispatchEvent(e) { this.emit(e.type, e); return true; }
}
function fixture() {
  let time = 0, center = [0, 0], res = 1, rotation = 0, lastPose;
  const jobs = [], cache = new Map(), views = [];
  const f = { jobs, cache, views, autoLoad: true, earlyRender: false, hideTiles: false, renderFrame: null,
    now: () => time, at: (t, fn) => jobs.push({ t, fn }), onLoad: () => {},
    async sleep(ms) {
      const end = time + ms;
      while (jobs.some(j => j.t <= end)) {
        jobs.sort((a, b) => a.t - b.t); const job = jobs.shift(); time = job.t; job.fn();
        await Promise.resolve(); await Promise.resolve();
      }
      time = end; await Promise.resolve(); await Promise.resolve();
    } };
  const projection = { getCode: () => 'synthetic' };
  const grid = { getExtent: () => [-10000, -10000, 10000, 10000], getZForResolution: r => r < 1 ? 1 : 0,
    getTileCoordExtent: ([z, x]) => [(x - 1) * 10000, -10000, x * 10000, 10000],
    getFullTileRange: () => ({ minX: 0, maxX: 1, minY: 0, maxY: 0 }),
    getTileRangeForExtentAndZ: () => ({ minX: 0, maxX: 1, minY: 0, maxY: 0 }) };
  const source = new Emitter(); Object.assign(source, { getTileGrid: () => grid, getKey: () => 'synthetic',
    getRevision: () => 0, getState: () => 'ready', getProjection: () => projection, getWrapX: () => false,
    getTile(z, x, y) {
      const key = `${z}/${x}/${y}`;
      if (!cache.has(key)) cache.set(key, { state: 2, getState() { return this.state; }, getTileCoord: () => [z, x, y],
        load(...args) {
          assert.equal(this, cache.get(key));
          if (this.state !== 0) return;
          this.state = 1; source.emit('tileloadstart', { tile: this }); f.onLoad(this, args);
        } });
      return cache.get(key);
    } });
  const layer = { getSource: () => source, getVisible: () => true, getOpacity: () => 1,
    getMinResolution: () => 0, getMaxResolution: () => Infinity, getMinZoom: () => -Infinity, getMaxZoom: () => Infinity, getExtent: () => null };
  const target = new Emitter(); target.id = 'viewport'; target.isConnected = true;
  const view = { getCenter: () => center, setCenter: c => { center = c; views.push([...c, res]); }, getState: () => ({ center }),
    getResolution: () => res, setResolution: r => { res = r; }, getRotation: () => rotation, setRotation: r => { rotation = r; },
    getZoom: () => 1, getProjection: () => projection, getAnimating: () => false, getInteracting: () => false };
  const queue = { getCount: () => [...cache.values()].filter(t => t.state === 0).length,
    getTilesLoading: () => [...cache.values()].filter(t => t.state === 1).length };
  const frame = () => ({ viewState: { center: [...center], resolution: res, rotation, projection }, size: [200, 200], tileQueue: queue });
  const map = new Emitter(); Object.assign(map, { getView: () => view, getSize: () => [200, 200], getTargetElement: () => target,
    getLayers: () => ({ getArray: () => [layer] }), renderSync() {
      if (!f.hideTiles) for (let x = 0; x < 2; x++) { const t = source.getTile(res < 1 ? 1 : 0, x, 0); if (f.autoLoad) t.load(); }
      const event = { frameState: f.renderFrame ?? frame() };
      map.emit('postrender', event);
      const pose = JSON.stringify([...center, res, rotation]);
      if (pose !== lastPose) { lastPose = pose; map.emit('moveend', event); }
      if (f.earlyRender || !queue.getCount() && !queue.getTilesLoading()) map.emit('rendercomplete', event);
    } });
  const client = { retrieveInstanceFrames() { return Promise.resolve([]); } };
  Object.assign(f, { map, source, layer, view, target, client, queue, frame });
  f.observeResources = () => ({ disconnect() {}, takeRecords: () => [] });
  f.open = () => createSession({ ...f });
  f.step = (session, options = {}) => measureStep({ ...f, session, change: () => view.setCenter([1, 0]), label: 'pan', classification: 'revisit', repetition: 1,
    control: { cancelled: false }, c: { ...defaults, quietMs: 500, timeoutMs: 2500 }, ...options });
  f.complete = tile => { tile.state = 2; target.emit('dicommicroscopyviewer_frame_loading_ended'); source.emit('tileloadend', { tile }); map.renderSync(); };
  f.loadAt = (start = 0, responseAt = 700, completeAt = 1000, z = 0) => {
    for (let x = 0; x < 2; x++) source.getTile(z, x, 0).state = 0;
    f.client.retrieveInstanceFrames = () => new Promise(resolve => f.at(responseAt, () => resolve([])));
    f.onLoad = tile => {
      target.emit('dicommicroscopyviewer_frame_loading_started');
      f.client.retrieveInstanceFrames({ opaque: true }).then(() => f.at(completeAt, () => f.complete(tile)));
    };
    if (start > 0) { f.autoLoad = false; f.at(start, () => { for (let x = 0; x < 2; x++) source.getTile(z, x, 0).load(); }); }
  };
  return f;
}

test('client instrumentation preserves exact promise, this, args, response, rejection and sync throws', async () => {
  for (const rejected of [false, true]) {
    const response = {}, error = Error('opaque'), args = [{ opaque: true }, Symbol('arg')], receiver = {};
    let received, context;
    const promise = rejected ? Promise.reject(error) : Promise.resolve(response);
    const client = { retrieveInstanceFrames(...a) { received = a; context = this; return promise; } };
    const original = client.retrieveInstanceFrames, counts = [];
    const restore = instrumentClient(client, { start: () => counts.push('start'), end: () => counts.push('end'), error: () => counts.push('error') });
    const returned = client.retrieveInstanceFrames.apply(receiver, args);
    assert.equal(returned, promise); assert.equal(context, receiver); assert.deepEqual(received, args);
    if (rejected) await assert.rejects(returned, e => e === error); else assert.equal(await returned, response);
    assert.deepEqual(counts, ['start', rejected ? 'error' : 'end']); restore(); assert.equal(client.retrieveInstanceFrames, original);
  }
  const error = Error('sync'), client = { retrieveInstanceFrames() { throw error; } };
  const original = client.retrieveInstanceFrames, restore = instrumentClient(client, { start() { throw Error('telemetry'); } });
  assert.throws(() => client.retrieveInstanceFrames(), e => e === error); restore(); assert.equal(client.retrieveInstanceFrames, original);
});
test('rendercomplete before a >500ms late load cannot complete while target tiles are IDLE', async () => {
  const f = fixture(); f.loadAt(700, 900, 1200); f.earlyRender = true;
  const session = f.open();
  try { const r = await f.step(session); assert.equal(r.terminal_state, 'completed'); assert.ok(r.technical_settled_ms >= 1700); }
  finally { session.close(); }
});
test('lower detail cache does not cover pending target level; decode follows WADO settlement', async () => {
  const f = fixture(); f.loadAt(0, 700, 1200, 1); f.earlyRender = true;
  const session = f.open(), debug = [];
  try {
    const r = await f.step(session, { change: () => f.view.setResolution(.5), debug: d => debug.push(d) });
    assert.equal(r.terminal_state, 'completed'); assert.deepEqual(r.technical_viewport_tile_coverage.levels, [1]);
    assert.ok(r.technical_settled_ms >= 1700);
    assert.ok(debug.some(d => d.pending.processing_observable_pending > 0 && d.pending.wado_pending === 0));
  } finally { session.close(); }
});
test('fully cached target completes without fabricating new WADO or frame activity', async () => {
  const f = fixture(), session = f.open();
  try { const r = await f.step(session); assert.equal(r.terminal_state, 'completed'); assert.equal(r.observation, 'valid_cached_tiles'); assert.equal(r.wado_count, 0); }
  finally { session.close(); }
});
test('missing cache evidence times out, never advances, and keeps settled null', async () => {
  const f = fixture(); f.hideTiles = true; f.earlyRender = true;
  const session = f.open(); let calls = 0;
  try {
    const r = await executeProtocol([1, 2], () => { calls++; return f.step(session); }, () => { throw Error('no transition allowed'); });
    assert.equal(calls, 1); assert.equal(r.status, 'failed'); assert.equal(r.rows[0].termination_reason, 'timeout'); assert.equal(r.rows[0].technical_settled_ms, null);
  } finally { session.close(); }
});
test('unsupported coverage with active WADO is indeterminate and stops all later movements', async () => {
  const f = fixture(); f.loadAt(0, 700, 1000); const session = f.open();
  f.layer.getSource = () => ({ }); let calls = 0;
  try {
    const r = await executeProtocol([1, 2], () => { calls++; return f.step(session, {
      change: () => { f.view.setCenter([1, 0]); f.source.getTile(0, 0, 0).load(); },
    }); }, async () => ({}));
    assert.equal(calls, 1); assert.equal(r.status, 'indeterminate'); assert.ok(r.rows[0].residual_operations.wado_pending > 0);
  } finally { session.close(); }
});
test('never-ending request fails at timeout with residual work, no claimed cancellation', async () => {
  const f = fixture(); f.loadAt(0, 100000, 100001); const session = f.open();
  try { const r = await f.step(session); assert.equal(r.terminal_state, 'failed'); assert.equal(r.timeout, true); assert.equal(r.residual_operations.wado_pending, 2); assert.equal(r.technical_settled_ms, null); }
  finally { session.close(); }
});
test('inherited operation cannot be cleared by unrelated frame ends and blocks next movement', async () => {
  const f = fixture(); f.loadAt(0, 900, 1300); const session = f.open();
  f.source.getTile(0, 0, 0).load(); // preparation epoch
  f.at(100, () => f.target.emit('dicommicroscopyviewer_frame_loading_ended'));
  try {
    await f.sleep(100);
    const before = f.views.length;
    const r = await f.step(session);
    assert.equal(r.terminal_state, 'failed'); assert.equal(r.termination_reason, 'entry_operations_not_drained');
    assert.equal(r.residual_operations.wado_pending, 1); assert.equal(f.views.length, before);
  } finally { session.close(); }
});
test('transition barrier revalidates earlier completion and blocks next movement on inherited loads', async () => {
  let movements = 0;
  const r = await executeProtocol([1, 2], async () => { movements++; return { terminal_state: 'completed', validity: 'valid', technical_settled_ms: 500 }; },
    async () => ({ terminal_state: 'failed', validity: 'invalid', termination_reason: 'timeout', residual_operations: { wado_pending: 1 } }));
  assert.equal(movements, 1); assert.equal(r.rows[0].terminal_state, 'failed'); assert.equal(r.rows[0].technical_settled_ms, null);
});
test('wrong center, rotation, resolution or viewport render is never accepted', async () => {
  for (const field of ['center', 'resolution', 'rotation', 'size']) {
    const f = fixture(), frame = f.frame();
    if (field === 'size') frame.size = [100, 100]; else frame.viewState[field] = field === 'center' ? [99, 99] : 9;
    f.renderFrame = frame; const session = f.open();
    try { const r = await f.step(session); assert.equal(r.terminal_state, 'failed'); assert.equal(r.technical_settled_ms, null); }
    finally { session.close(); }
  }
});
test('error, cancellation and unobservable pipeline each stop later dispatch', async () => {
  for (const mode of ['error', 'cancelled', 'unknown']) {
    const f = fixture(), session = f.open(), control = { cancelled: false }; let calls = 0;
    f.at(100, () => {
      if (mode === 'error') f.target.emit('dicommicroscopyviewer_frame_loading_error');
      if (mode === 'cancelled') control.cancelled = true;
      if (mode === 'unknown') f.target.emit('dicommicroscopyviewer_frame_loading_started');
    });
    try {
      const r = await executeProtocol([1, 2], () => { calls++; return f.step(session, { control }); }, async () => ({}));
      assert.equal(calls, 1); assert.equal(r.rows[0].technical_settled_ms, null);
      assert.equal(r.status, mode === 'cancelled' ? 'cancelled' : mode === 'unknown' ? 'indeterminate' : 'failed');
    } finally { session.close(); }
  }
});
test('source and tile.load instruments restore descriptors after errors and do not change return behavior', () => {
  const f = fixture(), tile = f.source.getTile(0, 0, 0), original = f.source.getTile, load = tile.load;
  const session = f.open(); f.source.getTile(0, 0, 0);
  assert.equal(tile.load(), undefined); session.close();
  assert.equal(f.source.getTile, original); assert.equal(tile.load, load);
  const error = Error('same'); f.source.getTile = function () { throw error; };
  const i = core.instrumentSources(f.map, () => {});
  try { assert.throws(() => f.source.getTile(0, 0, 0), e => e === error); } finally { i.restore(); }
});
test('rotated geometry excludes envelope corners and only selects the target level', async () => {
  const { default: TileGrid } = await import('ol/tilegrid/TileGrid.js');
  const f = fixture(), grid = new TileGrid({ extent: [-2, -2, 2, 2], origin: [-2, 2], resolutions: [1, .5], tileSize: 1 });
  f.source.getTileGrid = () => grid; f.map.getSize = () => [2, 2];
  f.view.setRotation(Math.PI / 4);
  assert.equal(core.expectedCoverage(f.map, new Map()).expected, 12);
  f.view.setRotation(0); assert.equal(core.expectedCoverage(f.map, new Map()).expected, 4);
  f.view.setResolution(.5); assert.deepEqual(core.expectedCoverage(f.map, new Map()).levels, [1]);
});
test('fixed target survives live View mutation only as diagnostic, never as a matching render', () => {
  const f = fixture(), target = captureTarget(f.map);
  assert.equal(matchesFrame(f.frame(), target), true);
  f.view.setCenter([9, 9]); assert.equal(matchesFrame(f.frame(), target), false);
});
test('percentiles include only completed rows and preserve failed/indeterminate counts', () => {
  const rows = [{ label: 'pan', terminal_state: 'completed', validity: 'valid', technical_settled_ms: 10 },
    { label: 'pan', terminal_state: 'completed', validity: 'valid', technical_settled_ms: 20 },
    { label: 'pan', terminal_state: 'failed', validity: 'invalid', technical_settled_ms: 9999 },
    { label: 'pan', terminal_state: 'indeterminate', validity: 'indeterminate' }];
  const s = core.summarize(rows)[0]; assert.equal(s.completed, 2); assert.equal(s.failed, 1); assert.equal(s.indeterminate, 1);
  assert.equal(s.percentiles.technical_settled_ms.p50, 15); assert.equal(s.percentiles.technical_settled_ms.p95, 19.5);
});
test('mutual exclusion and error cleanup release shared lock for every version', async () => {
  for (const owner of ['V2-auto', 'V2-manual', 'V3.1', 'V3.2', 'V3.3']) {
    const release = lock.acquireBenchmarkLock(owner);
    try { await assert.rejects(lock.withBenchmarkLock('V3.3', async () => {})); } finally { release(); }
  }
  await assert.rejects(lock.withBenchmarkLock('V3.3', () => { throw Error('synthetic'); })); assert.equal(lock.lockOwner(), null);
});
test('full synthetic protocol completes eight steps, restores client and releases lock', async () => {
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { hidden: false, querySelectorAll: () => [{}] };
  const f = fixture(), original = f.client.retrieveInstanceFrames;
  const api = installBenchmarkV33({ getMap: () => f.map }, { client: f.client });
  try {
    const result = await api.run({ quietMs: 50, timeoutMs: 300, cleanupTimeoutMs: 200, preparationWaitMs: 0, betweenStepsMs: 0 });
    assert.equal(result.status, 'completed'); assert.equal(result.runs.length, 8); assert.equal(result.schema_version, 3);
    assert.ok(result.runs.every(r => r.terminal_state === 'completed' && r.technical_settled_ms !== null));
    assert.equal(result.cleanup.requests_cancelled, undefined); assert.equal(result.cleanup.before_restore.requests_cancelled, false);
    assert.equal(f.client.retrieveInstanceFrames, original); assert.equal(lock.lockOwner(), null);
    assert.deepEqual(f.view.getCenter(), [0, 0]); assert.equal(f.view.getResolution(), 1);
    assert.ok(!JSON.stringify(result).includes('opaque'));
  } finally { delete globalThis.window; delete globalThis.document; }
});
test('full run cancellation/error/timeout restores methods and lock, keeps residual diagnostics', async () => {
  for (const mode of ['cancel', 'error', 'timeout']) {
    globalThis.window = { devicePixelRatio: 1 };
    globalThis.document = { hidden: false, querySelectorAll: () => [{}] };
    const f = fixture(), originalGetTile = f.source.getTile;
    if (mode === 'timeout') {
      f.client.retrieveInstanceFrames = () => new Promise(() => {});
      f.client.retrieveInstanceFrames(); // pre-existing untracked work is not counted as a proven zero
    }
    const originalClient = f.client.retrieveInstanceFrames, render = f.map.renderSync;
    let api, fired = false;
    f.map.renderSync = () => {
      render();
      if (!fired) {
        fired = true;
        if (mode === 'cancel') api.cancel();
        if (mode === 'error') f.target.emit('dicommicroscopyviewer_frame_loading_error');
        if (mode === 'timeout') f.client.retrieveInstanceFrames();
      }
    };
    api = installBenchmarkV33({ getMap: () => f.map }, { client: f.client });
    try {
      const result = await api.run({ quietMs: 50, timeoutMs: 150, cleanupTimeoutMs: 100, preparationWaitMs: 0, betweenStepsMs: 0 });
      assert.notEqual(result.status, 'completed'); assert.equal(result.runs.length, 0);
      assert.equal(f.client.retrieveInstanceFrames, originalClient); assert.equal(f.source.getTile, originalGetTile);
      assert.equal(lock.lockOwner(), null); assert.equal(api.isRunning(), false);
      if (mode === 'timeout') {
        assert.equal(result.cleanup.before_restore.residual.wado_pending, 1);
        assert.equal(result.cleanup.before_restore.requests_cancelled, false);
        assert.equal(result.reload_required, true);
        await assert.rejects(api.run(), /reload/);
      }
    } finally { delete globalThis.window; delete globalThis.document; }
  }
});
test('optional panel can be disabled immediately while telemetry and protocol keep working', async () => {
  const panels = [];
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { hidden: false, querySelectorAll: () => [{}],
    createElement: () => ({ style: {}, remove() { this.removed = true; } }),
    body: { appendChild: node => panels.push(node) } };
  const f = fixture(), api = installBenchmarkV33({ getMap: () => f.map }, { client: f.client });
  try {
    const pending = api.run({ debug: true, quietMs: 50, timeoutMs: 300, cleanupTimeoutMs: 200, preparationWaitMs: 0, betweenStepsMs: 0 });
    api.disableDebug(); assert.equal(panels.length, 1); assert.equal(panels[0].removed, true);
    const result = await pending; assert.equal(result.status, 'completed');
    assert.equal(lock.lockOwner(), null);
  } finally { delete globalThis.window; delete globalThis.document; }
});
test('unexpected dispatch exception preserves preceding rows and stops later actions', async () => {
  let calls = 0;
  const r = await executeProtocol([1, 2, 3], async () => {
    if (++calls === 2) throw Error('opaque');
    return { terminal_state: 'completed', validity: 'valid', technical_settled_ms: 500 };
  }, async () => ({ terminal_state: 'completed' }));
  assert.equal(calls, 2); assert.equal(r.rows.length, 2); assert.equal(r.rows[1].technical_settled_ms, null);
  assert.equal(r.status, 'failed'); assert.ok(!JSON.stringify(r).includes('opaque'));
});
test('cancellation already requested never invokes a new view change', async () => {
  const f = fixture(), session = f.open(); let changes = 0;
  try {
    const row = await f.step(session, { control: { cancelled: true }, change: () => { changes++; } });
    assert.equal(changes, 0); assert.equal(row.terminal_state, 'cancelled'); assert.equal(row.technical_settled_ms, null);
  } finally { session.close(); }
});
