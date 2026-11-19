import { withBenchmarkLock } from './benchmark-run-lock.js';
/**
 * OncoMETS automatic spatial navigation benchmark v3.1.
 * Independent from existing V2/V3 instrumentation. No PHI or DICOM URL exports.
 * Measures OpenLayers rendercomplete + resource timing (not clinical TFOV).
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();
const median = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const k = (s.length - 1) * p;
  const i = Math.floor(k);
  return Math.round((s[i] + (s[Math.min(i + 1, s.length - 1)] - s[i]) * (k - i)) * 10) / 10;
};
const almost = (a, b) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-7);
const sameCenter = (a, b) => !!a && !!b && almost(a[0], b[0]) && almost(a[1], b[1]);
const centerCopy = (view) => [...view.getCenter()];
const viewportCount = () => document.querySelectorAll('#viewport > .ol-viewport').length;
const frameResource = (entry) => /\/dicom-web\/.*\/frames\/\d+/i.test(entry.name) || /\/frames\/\d+/i.test(entry.name);
const ms = (n) => n == null ? null : Math.round(n * 10) / 10;
const heap = () => typeof performance.memory?.usedJSHeapSize === 'number' ? ms(performance.memory.usedJSHeapSize / 1048576) : null;

export function installBenchmarkV31(viewer) {
  if (!viewer || typeof viewer.getMap !== 'function') {
    console.warn('[V3.1] Viewer without getMap(); benchmark not installed.');
    return null;
  }
  if (window.oncometsBenchmarkV31?.isRunning?.()) {
    console.warn('[V3.1] An earlier benchmark is currently running.');
    return window.oncometsBenchmarkV31;
  }
  const map = viewer.getMap();
  if (!map || typeof map.getView !== 'function') {
    console.warn('[V3.1] Missing OpenLayers map.');
    return null;
  }
  let running = false;
  let cancelled = false;
  let lastResult = null;

  function setTargetCenter(target) {
    const view = map.getView();
    const before = centerCopy(view);
    view.setCenter(target);
    const actual = centerCopy(view);
    return { changed: !sameCenter(before, actual), actual };
  }

  async function setUpMovableView({ maxZoomSteps, preZoomFactor, panFraction, settleMs }) {
    const view = map.getView();
    const original = { center: centerCopy(view), resolution: view.getResolution() };
    const size = map.getSize();
    if (!size || size[0] < 50 || size[1] < 50) throw Error('Map viewport has invalid size.');
    const details = [];
    for (let i = 0; i <= maxZoomSteps; i++) {
      if (cancelled) throw Error('Benchmark cancelled');
      const base = centerCopy(view);
      const resolution = view.getResolution();
      const dx = size[0] * resolution * panFraction;
      const dy = size[1] * resolution * panFraction;
      const right = setTargetCenter([base[0] + dx, base[1]]).changed;
      view.setCenter(base);
      const down = setTargetCenter([base[0], base[1] - dy]).changed;
      view.setCenter(base);
      details.push({ attempt: i, resolution: ms(resolution), panRightPossible: right, panDownPossible: down });
      if (right && down) {
        map.renderSync();
        await sleep(settleMs);
        return { original, start: { center: centerCopy(view), resolution: view.getResolution() }, steps: i, diagnostics: details };
      }
      if (i === maxZoomSteps) break;
      view.setResolution(resolution / preZoomFactor);
      if (almost(view.getResolution(), resolution)) break;
      map.renderSync();
      await sleep(Math.min(settleMs, 250));
    }
    view.setCenter(original.center);
    view.setResolution(original.resolution);
    map.renderSync();
    throw Error('Could not establish movable view in both axes; diagnostics: ' + JSON.stringify(details));
  }

  async function measureStep(label, changeView, { quietMs, timeoutMs }) {
    const view = map.getView();
    const before = { center: centerCopy(view), resolution: view.getResolution() };
    const heapStart = heap();
    let renderCount = 0;
    let moveEndCount = 0;
    let firstRender = null;
    let latestRender = null;
    let lastResourceEnd = null;
    const t0 = now();
    const resources = [];
    const onRender = () => { renderCount++; latestRender = now(); if (firstRender == null) firstRender = latestRender; };
    const onMove = () => { moveEndCount++; };
    const onResources = (list) => {
      for (const e of list.getEntries()) {
        if (!frameResource(e) || e.startTime < t0) continue;
        resources.push(e);
        lastResourceEnd = Math.max(lastResourceEnd ?? 0, e.responseEnd || e.startTime);
      }
    };
    let observer = null;
    map.on('rendercomplete', onRender);
    map.on('moveend', onMove);
    try {
      if (typeof PerformanceObserver !== 'undefined') {
        observer = new PerformanceObserver(onResources);
        observer.observe({ type: 'resource', buffered: false });
      }
      changeView();
      const after = { center: centerCopy(view), resolution: view.getResolution() };
      const changed = !sameCenter(before.center, after.center) || !almost(before.resolution, after.resolution);
      if (!changed) return { label, outcome: 'no_view_change', measured: false, rendercomplete_events: 0, dicom_frames: 0 };
      map.renderSync();
      let outcome = 'timeout';
      while (now() - t0 < timeoutMs) {
        if (cancelled) { outcome = 'cancelled'; break; }
        await sleep(60);
        const t = now();
        const idleSince = Math.max(t0, latestRender ?? t0, lastResourceEnd ?? t0);
        if (firstRender != null && t - idleSince >= quietMs) { outcome = 'rendercomplete_quiet'; break; }
      }
      await sleep(40); // deliver queued resource observer callbacks
      const unique = [...new Map(resources.map(e => [`${e.name}|${e.startTime}`, e])).values()];
      const durations = unique.map(e => e.duration).filter(Number.isFinite);
      const transferred = unique.map(e => e.transferSize || 0);
      const anyUnavailable = unique.some(e => !e.transferSize);
      const totalTransfer = anyUnavailable ? null : transferred.reduce((a, b) => a + b, 0);
      return {
        label, outcome, measured: outcome === 'rendercomplete_quiet',
        interaction_to_first_rendercomplete_ms: firstRender == null ? null : ms(firstRender - t0),
        interaction_to_settled_ms: ms(now() - t0),
        rendercomplete_events: renderCount, moveend_events: moveEndCount,
        dicom_frames: unique.length, frame_http_p50_ms: median(durations, 0.5),
        frame_http_p95_ms: median(durations, 0.95), transfer_bytes: totalTransfer,
        heap_start_mb: heapStart, heap_end_mb: heap(),
      };
    } finally {
      map.un('rendercomplete', onRender);
      map.un('moveend', onMove);
      observer?.disconnect();
    }
  }

  function download() {
    if (!lastResult) throw Error('Run the benchmark before exporting.');
    const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `oncomets-benchmark-v31-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return lastResult;
  }

  async function run(options = {}) {
    if (running) throw Error('V3.1 is already running.');
    const config = {
      repetitions: 1, panFraction: 0.30, zoomFactor: 1.5,
      preZoomFactor: 1.8, maxZoomSteps: 9, quietMs: 450,
      timeoutMs: 15000, settleMs: 800, restoreOriginal: true,
      ...options,
    };
    if (!Number.isInteger(config.repetitions) || config.repetitions < 1 || config.repetitions > 20) throw Error('repetitions must be 1..20');
    if (!(config.panFraction > 0 && config.panFraction < 0.5)) throw Error('panFraction must be between 0 and 0.5');
    if (!(config.zoomFactor > 1 && config.zoomFactor <= 4)) throw Error('zoomFactor must be >1 and <=4');
    if (!(config.preZoomFactor > 1 && config.preZoomFactor <= 4)) throw Error('preZoomFactor must be >1 and <=4');
    if (viewportCount() !== 1) throw Error(`Expected exactly one main OpenLayers viewport; found ${viewportCount()}.`);
    if (map.getTargetElement()?.id !== 'viewport') throw Error('Viewer map is not targeting #viewport');
    running = true; cancelled = false;
    const view = map.getView();
    const original = { center: centerCopy(view), resolution: view.getResolution() };
    const result = {
      instrument: 'OncoMETS WSI spatial benchmark', version: '3.1',
      started_at: new Date().toISOString(),
      protocol: 'preconditioned-pan-zoom-return-v1', settings: config,
      viewport_px: map.getSize(),
      environment: 'Record origin and network route separately; browser timings are not clinical TFOV',
      preparation: null, runs: [],
      caveats: [
        'rendercomplete + quiet is a proxy, not clinical TFOV / full visual completeness',
        'New versus revisit requests depend on preexisting browser and service-worker caches',
        'Network timings may omit cached frames and cross-origin transferSize',
        'JS heap excludes GPU/graphics/OS memory',
        'The setup may fetch tiles; setup traffic is excluded from measured steps',
        'Pan/zoom commands are instantaneous (no animation) to avoid including animation duration',
      ],
    };
    try {
      console.log('[V3.1] Preparing movable view; preparation is NOT measured.');
      result.preparation = await setUpMovableView(config);
      await sleep(config.settleMs);
      const base = result.preparation.start;
      for (let repetition = 1; repetition <= config.repetitions; repetition++) {
        if (cancelled) break;
        // Each repetition starts from the same position and resolution.
        view.setResolution(base.resolution);
        view.setCenter(base.center);
        map.renderSync();
        await sleep(config.settleMs);
        const size = map.getSize();
        const dx = size[0] * base.resolution * config.panFraction;
        const dy = size[1] * base.resolution * config.panFraction;
        const actions = [
          ['pan-right-new', () => view.setCenter([base.center[0] + dx, base.center[1]])],
          ['return-right-revisit', () => view.setCenter(base.center)],
          ['pan-down-new', () => view.setCenter([base.center[0], base.center[1] - dy])],
          ['return-down-revisit', () => view.setCenter(base.center)],
          ['zoom-in', () => view.setResolution(base.resolution / config.zoomFactor)],
          ['zoom-out-revisit', () => view.setResolution(base.resolution)],
        ];
        for (const [label, action] of actions) {
          if (cancelled) break;
          const row = await measureStep(label, action, config);
          row.repetition = repetition;
          result.runs.push(row);
          console.log(`[V3.1] ${repetition}/${config.repetitions} ${label}:`, row);
          await sleep(120);
        }
      }
      result.status = cancelled ? 'cancelled' : 'completed';
    } catch (error) {
      result.status = 'error';
      result.error = String(error?.message || error);
      console.error('[V3.1]', error);
    } finally {
      if (config.restoreOriginal) {
        view.setResolution(original.resolution);
        view.setCenter(original.center);
        map.renderSync();
      }
      result.finished_at = new Date().toISOString();
      result.summary = {
        attempted: result.runs.length,
        measured: result.runs.filter(x => x.measured).length,
        no_view_change: result.runs.filter(x => x.outcome === 'no_view_change').length,
      };
      running = false;
      lastResult = result;
      console.table(result.runs.map(x => ({ step: x.label, outcome: x.outcome, first_render_ms: x.interaction_to_first_rendercomplete_ms, settled_ms: x.interaction_to_settled_ms, frames: x.dicom_frames })));
      console.log('[V3.1] Finished. Download: window.oncometsBenchmarkV31.download()');
    }
    return result;
  }
  const api = { run: (options) => withBenchmarkLock('V3.1', () => run(options)), download, getResults: () => lastResult, cancel: () => { cancelled = true; }, isRunning: () => running, getMap: () => map };
  window.oncometsBenchmarkV31 = api;
  console.log('[V3.1] Installed. Run: window.oncometsBenchmarkV31.run()');
  return api;
}
