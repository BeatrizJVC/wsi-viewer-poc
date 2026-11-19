import { expectedCoverage, instrumentSources, round } from './benchmark-v33-core.js';

const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-8);
const equal = (a, b) => a?.length === b?.length && a.every((x, i) => near(x, b[i]));
export function captureTarget(map) {
  const v = map.getView(), center = [...(v.getState?.().center ?? v.getCenter())];
  const rawCenter = [...v.getCenter()], resolution = v.getResolution(), rotation = v.getRotation();
  const size = [...map.getSize()], projection = v.getProjection(), zoom = v.getZoom();
  const view = { getState: () => ({ center }), getCenter: () => center, getResolution: () => resolution,
    getRotation: () => rotation, getProjection: () => projection, getZoom: () => zoom };
  return { center, rawCenter, resolution, rotation, size, view };
}
export function matchesFrame(frame, target) {
  const s = frame?.viewState;
  return !!s && equal(s.center, target.center) && near(s.resolution, target.resolution) && near(s.rotation, target.rotation) && equal(frame.size, target.size) &&
    s.projection?.getCode() === target.view.getProjection().getCode();
}
export function unchanged(map, target) {
  const t = captureTarget(map);
  return equal(t.rawCenter, target.rawCenter) && equal(t.center, target.center) && near(t.resolution, target.resolution) && near(t.rotation, target.rotation) && equal(t.size, target.size) &&
    t.view.getProjection().getCode() === target.view.getProjection().getCode();
}

// Observe settlement WITHOUT substituting a Promise, arguments, response, rejection or this.
// No options/results/error contents are read or retained. Hooks receive anonymous tokens only.
export function instrumentClient(client, hooks) {
  if (typeof client?.retrieveInstanceFrames !== 'function') throw Error('WADO instrumentation unavailable.');
  const descriptor = Object.getOwnPropertyDescriptor(client, 'retrieveInstanceFrames');
  const original = client.retrieveInstanceFrames;
  const safe = (kind, token) => { try { hooks[kind]?.(token); } catch { /* telemetry cannot affect caller */ } };
  function wrapper(...args) {
    const token = {}; safe('start', token);
    let result;
    try { result = Reflect.apply(original, this, args); }
    catch (error) { safe('error', token); throw error; }
    try {
      // Promise.prototype.then also accepts promises from another realm.
      Promise.prototype.then.call(result, () => safe('end', token), () => safe('error', token));
    } catch { safe('unknown', token); }
    return result;
  }
  client.retrieveInstanceFrames = wrapper;
  return () => { if (descriptor) Object.defineProperty(client, 'retrieveInstanceFrames', descriptor); else delete client.retrieveInstanceFrames; };
}

export function createSession({ map, client, now = () => performance.now(), observeResources = callback => {
  const o = new PerformanceObserver(list => callback(list.getEntries()));
  o.observe({ type: 'resource', buffered: false }); return o;
} }) {
  let active = null, epoch = 0, context = null, queue = null, observer, closed = false;
  let lastActivity = now(), dataSerial = 0, serial = 0, errorCount = 0, unknownRequests = 0, unknownFrames = 0;
  const cleanup = [], requests = new Map(), tiles = new Map(), ids = new WeakMap(), resourceKeys = new Set();
  let tileId = 0;
  function emit(kind, data = false) {
    if (closed) return;
    serial++; lastActivity = now(); if (data) dataSerial = serial;
    if (kind.endsWith('error')) errorCount++;
    if (active) {
      active.counts[kind] = (active.counts[kind] ?? 0) + 1;
      if (active.timeline.length < 20000) active.timeline.push({ kind, offset_ms: round(now() - active.t0) });
      else active.truncated = true;
    }
  }
  function remember(tile, source) {
    if (!tile) return null;
    let record = ids.get(tile);
    if (!record) {
      record = { id: ++tileId, ref: new WeakRef(tile), source, origin: epoch, hadResponse: false, requests: 0 };
      ids.set(tile, record); tiles.set(record.id, record);
    }
    return record;
  }
  let sources;
  const targetElement = map.getTargetElement();
  const session = {
    now, map,
    get registry() { return sources.registry; },
    get lastActivity() { return lastActivity; },
    get errorCount() { return errorCount; },
    get unverifiable() { return unknownRequests > 0 || unknownFrames > 0 || !session.client_available; },
    begin(label) {
      epoch++;
      active = { label, epoch, t0: now(), counts: {}, timeline: [], moveend_ms: null,
        first_rendercomplete_ms: null, last_render_ms: null, lastRenderSerial: -1, target: null, baseline: errorCount };
      return active;
    },
    end() { const row = active; active = null; return row; },
    setTarget(target) { active.target = target; },
    hasFreshRender() { return !!active && active.lastRenderSerial >= dataSerial && active.lastRenderSerial >= (active.moveSerial ?? Infinity); },
    coverage(target, maxTiles) { return expectedCoverage(map, sources.registry, maxTiles, target.view); },
    pending(coverage) {
      const counts = { wado_pending: requests.size, tiles_pending: 0, processing_observable_pending: 0,
        inherited_wado_pending: [...requests.values()].filter(r => r.origin < epoch).length,
        unknown_operations: unknownRequests + unknownFrames + (session.client_available ? 0 : 1),
        current_region_pending: 0, previous_region_pending: 0, other_region_pending: 0,
        queue_waiting: queue?.getCount?.() ?? null, queue_loading: queue?.getTilesLoading?.() ?? null };
      // Include loads discovered through getTile/state even when their start event preceded attachment.
      for (const [source, state] of sources.registry) for (const entry of state.tiles.values()) {
        const tile = entry.ref?.deref(); if (tile?.getState() === 1) remember(tile, source);
      }
      for (const record of tiles.values()) {
        const tile = record.ref.deref();
        if (tile?.getState() !== 1) continue;
        counts.tiles_pending++;
        if (record.hadResponse && !record.requests) counts.processing_observable_pending++;
        else if (!record.requests) counts.unknown_operations++;
        const coord = tile.getTileCoord?.();
        const key = coord?.join('/');
        if (coverage?.members?.some(m => m.source === record.source && m.key === key)) counts.current_region_pending++;
        else if (record.origin < epoch) counts.previous_region_pending++;
        else counts.other_region_pending++;
      }
      if (counts.queue_waiting === null || counts.queue_loading === null) counts.unknown_operations++;
      return counts;
    },
    drainable(p) { return !p.wado_pending && !p.tiles_pending && !p.unknown_operations && p.queue_waiting === 0 && p.queue_loading === 0; },
    flush() { if (observer?.takeRecords) resources(observer.takeRecords()); },
    client_available: false, resource_timing_available: false,
    close() {
      closed = true; active = null;
      for (const fn of cleanup.splice(0).reverse()) { try { fn(); } catch { /* restore all remaining instruments */ } }
      requests.clear(); tiles.clear(); resourceKeys.clear(); context = null; queue = null;
    },
  };
  function resources(entries) {
    for (const e of entries) {
      if (!/\/dicom-web\/.*\/frames\/\d+/i.test(e.name)) continue;
      const key = `${e.name}|${e.startTime}`;
      if (resourceKeys.has(key)) continue;
      resourceKeys.add(key); emit('wado_resource');
      if (active) {
        if (e.startTime >= active.t0) (active.durations ??= []).push(e.duration);
        else active.counts.inherited_wado_resources = (active.counts.inherited_wado_resources ?? 0) + 1;
      }
    }
  }
  try {
    sources = instrumentSources(map, (kind, evidence, detail) => {
      remember(detail?.tile, detail?.source); emit(kind, true);
      if (active && kind === 'tileloadend') {
        if (!evidence.start_observed_during_step) active.counts.tile_end_without_step_start = (active.counts.tile_end_without_step_start ?? 0) + 1;
        if (!evidence.start_observed_during_run) active.counts.tile_end_without_run_start = (active.counts.tile_end_without_run_start ?? 0) + 1;
      }
    }, () => epoch, {
      enter(tile, source) { const previous = context; context = remember(tile, source); return previous; },
      leave(previous) { context = previous; },
    });
    cleanup.push(() => sources.restore());
    if (client) {
      const finish = (token, failed) => {
        const r = requests.get(token); if (!r || closed) return;
        requests.delete(token);
        if (r.tile) { r.tile.requests--; r.tile.hadResponse = true; }
        emit(failed ? 'wado_error' : 'wado_ended', true);
        if (active && r.origin < epoch) active.counts.inherited_wado_ended = (active.counts.inherited_wado_ended ?? 0) + 1;
      };
      cleanup.push(instrumentClient(client, {
        start(token) { if (closed) return; requests.set(token, { tile: context, origin: epoch }); if (context) context.requests++; emit('wado_started', true); },
        end: token => finish(token, false), error: token => finish(token, true),
        unknown(token) { if (closed) return; requests.delete(token); unknownRequests++; emit('wado_state_unknown', true); },
      }));
      session.client_available = true;
    }
    for (const [suffix, kind] of [['started', 'frame_started'], ['ended', 'frame_ended'], ['error', 'frame_error']]) {
      const event = `dicommicroscopyviewer_frame_loading_${suffix}`;
      const fn = () => {
        // Never inspect event.detail. Frame ends have no safe anonymous identity.
        if (suffix === 'started' && !context) unknownFrames++;
        emit(kind, true);
      };
      targetElement.addEventListener(event, fn); cleanup.push(() => targetElement.removeEventListener(event, fn));
    }
    for (const kind of ['postrender', 'moveend', 'rendercomplete']) {
      const fn = event => {
        if (event.frameState?.tileQueue) queue = event.frameState.tileQueue;
        if (!active?.target || !matchesFrame(event.frameState, active.target)) return;
        if (kind === 'moveend') {
          emit(kind); active.moveend_ms = now() - active.t0; active.moveSerial = serial;
        } else if (kind === 'rendercomplete') {
          // Repeated renders alone must not restart the data stability window.
          serial++; active.counts.rendercomplete = (active.counts.rendercomplete ?? 0) + 1;
          active.first_rendercomplete_ms ??= now() - active.t0;
          active.last_render_ms = now() - active.t0; active.lastRenderSerial = serial;
        }
      };
      map.on(kind, fn); cleanup.push(() => map.un(kind, fn));
    }
    try { observer = observeResources(resources); cleanup.push(() => observer.disconnect()); session.resource_timing_available = true; }
    catch { /* optional duration telemetry; client settlement still required */ }
  } catch { session.close(); throw Error('Session instrumentation unavailable.'); }
  return session;
}

export function coverageCounts(coverage) {
  const { signature, members, ...counts } = coverage;
  return counts;
}
