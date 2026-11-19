import { withBenchmarkLock } from './benchmark-run-lock.js';
/**
 * OncoMETS WSI benchmark V3.2 — field-of-view navigation protocol.
 * Research-inspired; NOT a validated clinical TFOV measurement.
 * No endpoint, URL, UID, patient data or frame identifiers are exported.
 * Source: Schüffler et al., Arch Pathol Lab Med 2022, doi:10.5858/arpa.2021-0197-OA.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = () => performance.now();
const round = (v) => Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
const quantile = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * p, i = Math.floor(pos);
  return round(s[i] + (s[Math.min(i + 1, s.length - 1)] - s[i]) * (pos - i));
};
const copy = (v) => [...v.getCenter()];
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-7, Math.abs(a) * 1e-7);
const same = (a, b) => near(a[0], b[0]) && near(a[1], b[1]);
const frame = (e) => /\/frames\/\d+(?:\b|[/?#])/i.test(e.name) && /dicom-web/i.test(e.name);
const heap = () => typeof performance.memory?.usedJSHeapSize === 'number'
  ? round(performance.memory.usedJSHeapSize / 1048576) : null;
const safeErr = (e) => String(e?.message || e).slice(0, 300);

// Listen only to sources belonging to the primary OpenLayers map; overview map is excluded.
function tileSources(map) {
  const sources = new Set();
  function visit(group) {
    const items = group?.getLayers?.()?.getArray?.() || [];
    for (const layer of items) {
      if (typeof layer.getLayers === 'function') visit(layer);
      else {
        const s = layer?.getSource?.();
        if (s && typeof s.on === 'function' && typeof s.un === 'function') sources.add(s);
      }
    }
  }
  visit(map);
  return [...sources];
}

export function installBenchmarkV32(viewer) {
  if (!viewer || typeof viewer.getMap !== 'function') return null;
  const map = viewer.getMap();
  if (!map?.getView || !map?.getTargetElement) return null;
  if (window.oncometsBenchmarkV32?.isRunning?.()) {
    console.warn('[V3.2] Existing V3.2 run is active; keeping it.');
    return window.oncometsBenchmarkV32;
  }
  let busy = false, cancelled = false, last = null;
  const view = () => map.getView();
  const setView = (center, resolution) => {
    if (Number.isFinite(resolution)) view().setResolution(resolution);
    if (center) view().setCenter(center);
    map.renderSync();
  };
  function moveCandidate(base, x, y, resolution) {
    const v = view();
    const old = copy(v), oldR = v.getResolution();
    setView([base[0] + x, base[1] + y], resolution);
    const actual = copy(v), actualR = v.getResolution();
    setView(old, oldR);
    return { possible: same(actual, [base[0] + x, base[1] + y]) && near(actualR, resolution), actual };
  }
  async function prepare(c) {
    const v = view();
    const original = { center: copy(v), resolution: v.getResolution() };
    const sz = map.getSize();
    if (!sz || sz.some(x => x < 100)) throw Error('Viewport too small (<100 px).');
    const tests = [];
    // Deliberate magnification before pan: v3.1 often tested a fully cached low-power overview.
    let target = original.resolution / c.preZoomFactor;
    for (let attempt = 0; attempt < c.maxZoomSteps; attempt++) {
      if (cancelled) throw Error('Cancelled during setup');
      setView(original.center, target);
      const actual = v.getResolution(), base = copy(v);
      const dx = sz[0] * actual * c.panFraction;
      const dy = sz[1] * actual * c.panFraction;
      const xsign = moveCandidate(base, dx, 0, actual).possible ? 1 : (moveCandidate(base, -dx, 0, actual).possible ? -1 : 0);
      const ysign = moveCandidate(base, 0, -dy, actual).possible ? -1 : (moveCandidate(base, 0, dy, actual).possible ? 1 : 0);
      const diagonal = !!(xsign && ysign && moveCandidate(base, xsign * dx, ysign * dy, actual).possible);
      tests.push({ attempt, magnification_relative: round(original.resolution / actual), x_possible: !!xsign, y_possible: !!ysign, diagonal_possible: diagonal });
      if (diagonal && original.resolution / actual >= c.minimumActualZoomFactor) {
        setView(base, actual);
        await wait(c.preparationWaitMs);
        return { original, start: { center: base, resolution: actual }, offsets: { x: xsign * dx, y: ysign * dy }, zoom_checks: tests };
      }
      if (attempt > 0 && near(actual, target * c.preZoomFactor)) break; // constrained resolution
      target = actual / c.additionalZoomFactor;
      await wait(100);
    }
    throw Error('Unable to establish a zoomed view with diagonal movement; see console for target constraints.');
  }

  async function step(label, change, c, repetition, classification) {
    const v = view();
    const t0 = clock(), startCenter = copy(v), startResolution = v.getResolution();
    const startHeap = heap();
    const r = [], sourceStates = tileSources(map);
    let firstRender = null, lastActivity = t0, renders = 0, moves = 0;
    let loadsStart = 0, loadsEnd = 0, loadsError = 0;
    const onRender = () => { renders++; firstRender ??= clock(); lastActivity = clock(); };
    const onMove = () => { moves++; lastActivity = clock(); };
    const onTileStart = () => { loadsStart++; lastActivity = clock(); };
    const onTileEnd = () => { loadsEnd++; lastActivity = clock(); };
    const onTileError = () => { loadsError++; lastActivity = clock(); };
    let observer = null;
    map.on('rendercomplete', onRender);
    map.on('moveend', onMove);
    for (const s of sourceStates) { s.on('tileloadstart', onTileStart); s.on('tileloadend', onTileEnd); s.on('tileloaderror', onTileError); }
    try {
      if (typeof PerformanceObserver !== 'undefined') {
        observer = new PerformanceObserver(list => {
          for (const e of list.getEntries()) if (frame(e) && e.startTime >= t0 - 1) {
            r.push(e); lastActivity = clock();
          }
        });
        try { observer.observe({ type: 'resource', buffered: false }); } catch { observer.disconnect(); observer = null; }
      }
      change();
      map.renderSync();
      const finalCenter = copy(v), finalResolution = v.getResolution();
      const changed = !same(startCenter, finalCenter) || !near(startResolution, finalResolution);
      if (!changed) return { repetition, label, classification, outcome: 'no_view_change', valid_movement: false, frames: 0 };
      let outcome = 'timeout';
      while (clock() - t0 < c.timeoutMs) {
        if (cancelled) { outcome = 'cancelled'; break; }
        await wait(40);
        if (firstRender !== null && clock() - lastActivity >= c.quietMs) { outcome = 'rendercomplete_quiet'; break; }
      }
      await wait(35); // resource observer delivery
      const unique = [...new Map(r.map(e => [`${e.name}|${e.startTime}`, e])).values()];
      const durations = unique.map(e => e.duration).filter(n => Number.isFinite(n) && n >= 0);
      // Cross-origin lack of Timing-Allow-Origin can make transferSize 0 (unknown, not a cache hit).
      const allReadable = unique.length > 0 && unique.every(e => e.transferSize > 0);
      const bytes = allReadable ? unique.reduce((n, e) => n + e.transferSize, 0) : null;
      const valid = outcome === 'rendercomplete_quiet';
      return {
        repetition, label, classification, outcome, valid_movement: true,
        completed_render: valid, fov_rendercomplete_proxy_ms: firstRender === null ? null : round(firstRender - t0),
        end_to_quiet_proxy_ms: round(clock() - t0),
        rendercomplete_events: renders, moveend_events: moves,
        requested_dicom_frames_observed: unique.length,
        openlayers_tile_load_start: loadsStart,
        openlayers_tile_load_end: loadsEnd,
        openlayers_tile_load_error: loadsError,
        resource_duration_p50_ms: quantile(durations, .5),
        resource_duration_p95_ms: quantile(durations, .95),
        transfer_bytes_if_exposed: bytes,
        js_heap_before_mb: startHeap, js_heap_after_mb: heap(),
        novel_frames_observed: unique.length > 0 || loadsStart > 0,
        displacement_viewports_x: round((finalCenter[0] - startCenter[0]) / (map.getSize()[0] * finalResolution)),
        displacement_viewports_y: round((finalCenter[1] - startCenter[1]) / (map.getSize()[1] * finalResolution)),
        resolution_ratio: round(startResolution / finalResolution),
      };
    } finally {
      observer?.disconnect();
      map.un('rendercomplete', onRender); map.un('moveend', onMove);
      for (const s of sourceStates) { s.un('tileloadstart', onTileStart); s.un('tileloadend', onTileEnd); s.un('tileloaderror', onTileError); }
    }
  }

  function summarize(rows) {
    const types = [...new Set(rows.map(r => r.label))];
    return types.map(label => {
      const records = rows.filter(r => r.label === label);
      const complete = records.filter(r => r.completed_render);
      const t = complete.map(r => r.fov_rendercomplete_proxy_ms).filter(Number.isFinite);
      return {
        label, total: records.length, complete: complete.length,
        with_new_frame_evidence: records.filter(r => r.novel_frames_observed).length,
        fov_p50_ms: quantile(t, .5), fov_p95_ms: quantile(t, .95),
        frames_total: records.reduce((n, r) => n + (r.requested_dicom_frames_observed || 0), 0),
      };
    });
  }
  function download() {
    if (!last) throw Error('Run V3.2 first.');
    const u = URL.createObjectURL(new Blob([JSON.stringify(last, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = u; a.download = `oncomets-benchmark-v32-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
    return last;
  }
  async function run(options = {}) {
    if (busy) throw Error('V3.2 already running');
    if (window.oncometsBenchmarkV31?.isRunning?.() || window.oncometsBenchmarkV2?.isRunning?.()) throw Error('Stop other benchmarks first.');
    const c = {
      repetitions: 1, panFraction: 0.85, preZoomFactor: 8,
      minimumActualZoomFactor: 3, additionalZoomFactor: 1.7, maxZoomSteps: 7,
      zoomFactor: 1.5, preparationWaitMs: 1400, betweenStepsMs: 170,
      quietMs: 450, timeoutMs: 15000, restoreOriginal: true,
      cacheCondition: 'uncontrolled', ...options,
    };
    if (!Number.isInteger(c.repetitions) || c.repetitions < 1 || c.repetitions > 30) throw Error('repetitions must be between 1 and 30');
    if (!(c.panFraction > .5 && c.panFraction <= 1.2)) throw Error('panFraction must be between 0.5 and 1.2');
    if (!(c.preZoomFactor >= 2 && c.preZoomFactor <= 32)) throw Error('preZoomFactor must be 2..32');
    if (!['uncontrolled','cold-attempt','warm'].includes(c.cacheCondition)) throw Error('Invalid cacheCondition');
    if (document.querySelectorAll('#viewport > .ol-viewport').length !== 1) throw Error('Exactly one primary OL viewport is required.');
    if (map.getTargetElement()?.id !== 'viewport') throw Error('Viewer map does not target #viewport');
    busy = true; cancelled = false;
    const original = { center: copy(view()), resolution: view().getResolution() };
    const results = {
      instrument: 'OncoMETS WSI FOV navigation benchmark', version: '3.2',
      method: 'rendercomplete as OpenLayers full-viewport completion proxy; not clinical TFOV',
      started_at: new Date().toISOString(), protocol: 'spatial-new-vs-revisit-v1',
      settings: c, viewport_css_px: map.getSize(), device_pixel_ratio: window.devicePixelRatio,
      browser: navigator.userAgent, page_origin: location.origin,
      cache_condition_declared: c.cacheCondition,
      cache_cleared_by_instrument: false,
      preparation: null, runs: [], summary_by_step: [],
      sources: [
        'Schueffler et al. 2022 https://doi.org/10.5858/arpa.2021-0197-OA',
        'OpenLayers Map rendercomplete https://openlayers.org/en/latest/apidoc/module-ol_Map-Map.html',
        'W3C Resource Timing https://www.w3.org/TR/resource-timing/'
      ],
      caveats: [
        'Case opening (TOC) and slide switching (TCS) are not measured here.',
        'This is an automated FOV completion proxy, not independently validated full visual TFOV.',
        'A pan labelled new is only a candidate until new frame/tile loads are observed.',
        'No frame requests may mean application cache, browser cache, prefetched tiles, or low-detail zoom.',
        'Cold-attempt designation requires external browser/server cache control; Resource Timing clearing does not clear caches.',
        'Resource entry duration is not server-only HTTP latency; cross-origin detail may be restricted.',
        'transferSize 0 or missing is unknown with restricted Timing-Allow-Origin, not proof of cache hit.',
        'Heap is JavaScript memory, not full browser RAM or GPU usage.',
        'Compare across environments only when viewport, magnification, browser and network conditions match.',
        'Schueffler et al. filtered navigation events by tile counts relative to expected; this instrument does not yet implement that filter.'
      ],
    };
    try {
      performance.setResourceTimingBufferSize?.(5000);
      console.log('[V3.2] Preparing at higher magnification (setup excluded from measurements).');
      const prep = await prepare(c);
      // Do not export raw center coordinates, which may be sensitive spatial metadata.
      results.preparation = {
        initial_resolution: round(prep.original.resolution), measurement_resolution: round(prep.start.resolution),
        achieved_zoom_factor: round(prep.original.resolution / prep.start.resolution),
        zoom_checks: prep.zoom_checks,
        offset_x_in_fov: round(prep.offsets.x / (map.getSize()[0] * prep.start.resolution)),
        offset_y_in_fov: round(prep.offsets.y / (map.getSize()[1] * prep.start.resolution))
      };
      const base = prep.start.center, res = prep.start.resolution;
      const dx = prep.offsets.x, dy = prep.offsets.y;
      const actions = [
        ['pan-new-horizontal', 'new-region-candidate', () => setView([base[0] + dx, base[1]], res)],
        ['pan-new-diagonal', 'new-region-candidate', () => setView([base[0] + dx, base[1] + dy], res)],
        ['pan-new-vertical', 'new-region-candidate', () => setView([base[0], base[1] + dy], res)],
        ['pan-return-base', 'revisit', () => setView(base, res)],
        ['pan-revisit-horizontal', 'revisit', () => setView([base[0] + dx, base[1]], res)],
        ['pan-return-base-again', 'revisit', () => setView(base, res)],
        ['zoom-in', 'zoom-new-detail', () => setView(base, res / c.zoomFactor)],
        ['zoom-out-return', 'revisit', () => setView(base, res)],
      ];
      for (let rep = 1; rep <= c.repetitions && !cancelled; rep++) {
        setView(base, res);
        await wait(c.preparationWaitMs);
        for (const [label, classification, fn] of actions) {
          if (cancelled) break;
          const row = await step(label, fn, c, rep, classification);
          results.runs.push(row);
          console.log(`[V3.2] ${rep}/${c.repetitions} ${label}`, row.outcome, 'frames', row.requested_dicom_frames_observed ?? 0);
          await wait(c.betweenStepsMs);
        }
      }
      results.status = cancelled ? 'cancelled' : 'completed';
    } catch (e) {
      results.status = 'error'; results.error = safeErr(e);
      console.error('[V3.2] Error:', e);
    } finally {
      if (c.restoreOriginal) setView(original.center, original.resolution);
      results.finished_at = new Date().toISOString();
      results.summary_by_step = summarize(results.runs);
      results.quality_checks = {
        all_movements_valid: results.runs.length > 0 && results.runs.every(r => r.valid_movement),
        complete_render_count: results.runs.filter(r => r.completed_render).length,
        observed_novel_frame_steps: results.runs.filter(r => r.classification === 'new-region-candidate' && r.novel_frames_observed).length,
        candidate_new_steps_total: results.runs.filter(r => r.classification === 'new-region-candidate').length,
        eligible_as_controlled_new_fov_sample: results.runs.filter(r => r.classification === 'new-region-candidate' && r.completed_render && r.novel_frames_observed).length,
      };
      last = results; busy = false;
      console.table(results.summary_by_step);
      console.log('[V3.2] Done. Export: window.oncometsBenchmarkV32.download()');
    }
    return results;
  }
  const api = {run: (options) => withBenchmarkLock('V3.2', () => run(options)), download, cancel: () => { cancelled = true; }, getResults: () => last, isRunning: () => busy};
  window.oncometsBenchmarkV32 = api;
  console.log('[V3.2] Installed. Run: await window.oncometsBenchmarkV32.run({repetitions:1})');
  return api;
}
