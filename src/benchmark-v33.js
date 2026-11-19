import { withBenchmarkLock, lockOwner } from './benchmark-run-lock.js';
import { percentile, round, summarize } from './benchmark-v33-core.js';
import { createSession, captureTarget, unchanged, coverageCounts } from './benchmark-v33-session.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const near = (a, b) => Math.abs(a - b) <= Math.max(1e-7, Math.abs(a) * 1e-7);
const same = (a, b) => a.length === b.length && a.every((n, i) => near(n, b[i]));
export const defaults = Object.freeze({ repetitions: 1, cacheCondition: 'uncontrolled', panFraction: .85,
  preZoomFactor: 8, minimumActualZoomFactor: 3, additionalZoomFactor: 1.7, maxZoomSteps: 7,
  zoomFactor: 1.5, quietMs: 500, timeoutMs: 15000, cleanupTimeoutMs: 5000,
  preparationWaitMs: 1400, betweenStepsMs: 170, maxTiles: 10000, debug: false });
function settings(options) {
  if (Object.keys(options).some(k => !(k in defaults))) throw Error('Unknown V3.3 option.');
  const c = { ...defaults, ...options };
  for (const [key, min, max] of [['repetitions', 1, 30], ['maxZoomSteps', 1, 10], ['maxTiles', 1, 50000]]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw Error('Invalid integer setting.');
  }
  for (const [key, min, max] of [['panFraction', .51, 1.2], ['preZoomFactor', 2, 32], ['minimumActualZoomFactor', 2, 32],
    ['additionalZoomFactor', 1.1, 4], ['zoomFactor', 1.1, 4], ['quietMs', 50, 5000], ['timeoutMs', 100, 60000],
    ['cleanupTimeoutMs', 100, 60000], ['preparationWaitMs', 0, 5000], ['betweenStepsMs', 0, 5000]]) {
    if (!Number.isFinite(c[key]) || c[key] < min || c[key] > max) throw Error('Invalid numeric setting.');
  }
  if (typeof c.debug !== 'boolean' || c.quietMs >= c.timeoutMs || !['uncontrolled', 'cold-attempt', 'warm'].includes(c.cacheCondition)) throw Error('Invalid cache or timing setting.');
  return c;
}

// Also used for transition verification: no change is allowed only for explicit barriers.
export async function measureStep({ map, session, change, label, classification, repetition, c, control,
  sleep = wait, debug = () => {}, allowNoMovement = false }) {
  const before = captureTarget(map), a = session.begin(label), t0 = a.t0;
  let target, coverage = {}, pending = {}, terminal = 'failed', reason = 'measurement_error', timedOut = false;
  let stateFingerprint, stableSince = session.now(), geometrySignature, checks = {};
  try {
    measurement: {
    pending = session.pending();
    if (control.cancelled) { terminal = 'cancelled'; reason = 'cancelled_by_user'; break measurement; }
    // Last synchronous admission check closes the gap after an awaited transition barrier.
    if (change && !allowNoMovement && (pending.wado_pending || pending.tiles_pending ||
        pending.queue_waiting > 0 || pending.queue_loading > 0 || session.unverifiable)) {
      terminal = session.unverifiable ? 'indeterminate' : 'failed'; reason = 'entry_operations_not_drained';
      checks = { entry_operations_drained: false }; break measurement;
    }
    change?.(); target = captureTarget(map); session.setTarget(target);
    const changed = !same([...before.rawCenter, before.resolution], [...target.rawCenter, target.resolution]);
    if (!changed && !allowNoMovement) reason = 'no_view_change';
    else {
      if (!changed) { a.moveend_ms = 0; a.moveSerial = 0; }
      map.renderSync();
      const deadline = t0 + c.timeoutMs;
      while (true) {
        session.flush(); coverage = session.coverage(target, c.maxTiles); pending = session.pending(coverage);
        const fp = JSON.stringify([coverage.expected, coverage.loaded, coverage.missing, coverage.pending, coverage.errors]);
        if (fp !== stateFingerprint) {
          stateFingerprint = fp; stableSince = session.now(); a.lastRenderSerial = -1;
        }
        const geometryChanged = geometrySignature !== undefined && geometrySignature !== coverage.signature;
        geometrySignature = coverage.signature;
        const moving = map.getView().getAnimating?.() || map.getView().getInteracting?.();
        const stableFor = session.now() - Math.max(stableSince, session.lastActivity);
        checks = { movement_finished: a.moveend_ms !== null && !moving,
          target_unchanged: unchanged(map, target) && !geometryChanged,
          target_render_verified: session.hasFreshRender(), coverage_established: coverage.established === true,
          coverage_complete: coverage.complete === true, operations_drained: session.drainable(pending),
          stability_window_satisfied: stableFor >= c.quietMs };
        if (control.cancelled) { terminal = 'cancelled'; reason = 'cancelled_by_user'; break; }
        if (!checks.target_unchanged || !map.getTargetElement()?.isConnected || globalThis.document?.hidden === true) { reason = 'target_or_environment_changed'; break; }
        if (session.errorCount || coverage.errors) { reason = 'tile_frame_or_wado_error'; break; }
        const unsupported = ['invalid_view_geometry', 'unsupported_visible_layer', 'empty_visible_extent'].includes(coverage.reason);
        if (unsupported) { terminal = 'indeterminate'; reason = coverage.reason; break; }
        if (session.unverifiable) { terminal = 'indeterminate'; reason = session.client_available ? 'unattributed_pipeline_or_request_state' : 'wado_instrumentation_unavailable'; break; }
        // A fresh confirmation frame must represent the FIXED target after coverage/data changed.
        if (checks.movement_finished && checks.coverage_complete && checks.operations_drained && !checks.target_render_verified) {
          map.renderSync(); checks.target_render_verified = session.hasFreshRender();
        }
        if (Object.values(checks).every(Boolean) && session.now() <= deadline) { terminal = 'completed'; reason = 'target_covered_rendered_drained_and_stable'; break; }
        if (session.now() >= deadline) { timedOut = true; reason = 'timeout'; break; }
        const waiting = [
          !checks.movement_finished && 'target_moveend_missing',
          coverage.missing > 0 && 'target_tiles_unobserved', coverage.pending > 0 && 'target_tiles_not_loaded',
          pending.wado_pending > 0 && 'wado_requests_pending', pending.processing_observable_pending > 0 && 'post_wado_processing_pending',
          pending.tiles_pending > 0 && 'tile_loads_pending', pending.unknown_operations > 0 && 'operation_state_unknown',
          pending.queue_waiting > 0 && 'renderer_queue_pending', pending.queue_loading > 0 && 'renderer_loading_pending',
          !checks.target_render_verified && 'matching_target_render_missing', !checks.stability_window_satisfied && 'stability_window_not_elapsed',
        ].filter(Boolean).join(', ');
        debug({ label, state: !checks.movement_finished ? 'moving' : !checks.coverage_complete || !checks.operations_drained ? 'loading' : 'verifying',
          elapsed_ms: round(session.now() - t0), waiting_reason: waiting, coverage: coverageCounts(coverage), pending });
        await sleep(Math.min(25, deadline - session.now()));
      }
    }
    }
  } catch {
    terminal = 'failed'; reason = 'measurement_instrumentation_error';
    try { pending = session.pending(coverage); } catch { pending = { unknown_operations: 1 }; }
  }
  finally { session.end(); }
  const counts = a.counts, durations = a.durations ?? [];
  const row = { label, classification, repetition, cache_condition_declared: c.cacheCondition,
    terminal_state: terminal, termination_reason: reason, timeout: timedOut,
    validity: terminal === 'completed' ? 'valid' : terminal === 'indeterminate' ? 'indeterminate' : 'invalid',
    exclusion_reasons: terminal === 'completed' ? [] : [reason],
    technical_settled_ms: terminal === 'completed' ? round(session.now() - t0) : null,
    elapsed_ms: round(session.now() - t0), moveend_ms: round(a.moveend_ms),
    frame_complete_ms: null, decoder_only_timing: 'unavailable',
    first_rendercomplete_ms: round(a.first_rendercomplete_ms), last_render_ms: round(a.last_render_ms),
    rendercomplete_events: counts.rendercomplete ?? 0, tileloadstart: counts.tileloadstart ?? 0,
    tileloadend: counts.tileloadend ?? 0, tileloaderror: counts.tileloaderror ?? 0,
    frame_started: counts.frame_started ?? 0, frame_ended: counts.frame_ended ?? 0, frame_error: counts.frame_error ?? 0,
    wado_count: counts.wado_started ?? 0, wado_resource_count: counts.wado_resource ?? 0,
    event_counts: counts, residual_operations: pending, completion_checks: checks,
    technical_viewport_tile_coverage: coverageCounts(coverage),
    wado_resource_duration_ms: durations.map(round), wado_resource_p50_ms: percentile(durations, .5), wado_resource_p95_ms: percentile(durations, .95),
    activity_timeline: a.timeline, timeline_truncated: !!a.truncated,
    resource_timing_available: session.resource_timing_available, clinical_visual_completeness: 'not_verified' };
  if (terminal === 'completed') row.observation = row.wado_count > 0 ? 'valid_with_new_wado'
    : row.frame_started || row.frame_ended || row.tileloadstart || row.tileloadend || row.wado_resource_count
      ? 'valid_without_observed_wado' : 'valid_cached_tiles';
  debug({ label, state: terminal === 'completed' ? 'settled' : 'failed', elapsed_ms: row.elapsed_ms,
    waiting_reason: reason, coverage: row.technical_viewport_tile_coverage, pending });
  return row;
}

// The only routine that dispatches measured movements. Exposed to test no-next-move guarantees.
function revokeCompletion(row, barrier) {
  row.transition = barrier; row.provisional_completion_elapsed_ms = row.technical_settled_ms;
  row.terminal_state = barrier.terminal_state; row.validity = barrier.validity;
  row.technical_settled_ms = null; row.termination_reason = 'transition_not_verified';
  row.exclusion_reasons = ['transition_not_verified', barrier.termination_reason];
}
export async function executeProtocol(actions, perform, verifyTransition, pause = async () => {}) {
  const rows = [];
  const failure = () => ({ terminal_state: 'failed', validity: 'invalid', termination_reason: 'dispatch_instrumentation_error',
    technical_settled_ms: null, exclusion_reasons: ['dispatch_instrumentation_error'] });
  for (const action of actions) {
    if (rows.length) {
      let barrier;
      try { await pause(); barrier = await verifyTransition(rows.at(-1)); } catch { barrier = failure(); }
      rows.at(-1).transition = barrier;
      if (barrier.terminal_state !== 'completed') {
        revokeCompletion(rows.at(-1), barrier);
        return { status: barrier.terminal_state, rows };
      }
    }
    let row;
    try { row = await perform(action); } catch { row = { ...failure(), label: Array.isArray(action) && typeof action[0] === 'string' ? action[0] : 'dispatch' }; }
    rows.push(row);
    if (row.terminal_state !== 'completed') return { status: row.terminal_state, rows };
  }
  return { status: 'completed', rows };
}

export async function drain(session, map, timeoutMs, quietMs, sleep = wait, { control = null, ignoreErrors = false } = {}) {
  const start = session.now();
  map.renderSync();
  while (true) {
    session.flush(); const residual = session.pending();
    if (control?.cancelled) return { status: 'cancelled', residual, requests_cancelled: false };
    if (!ignoreErrors && session.errorCount) return { status: 'failed', reason: 'tile_frame_or_wado_error', residual, requests_cancelled: false };
    if (session.drainable(residual) && session.now() - session.lastActivity >= quietMs) return { status: 'drained', residual, requests_cancelled: false };
    if (session.now() - start >= timeoutMs) return { status: 'timeout', residual, requests_cancelled: false };
    await sleep(Math.min(25, timeoutMs - (session.now() - start)));
  }
}

function diagnosticPanel(enabled) {
  let node, last = -Infinity;
  if (enabled) {
    node = document.createElement('pre'); node.className = 'oncomets-v33-debug';
    node.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:10000;background:#111e;color:#fff;padding:12px;max-width:460px;pointer-events:none;font:12px monospace;white-space:pre-wrap';
    document.body.appendChild(node);
  }
  return { close: () => { node?.remove(); node = null; }, update(info) {
    if (!node || (performance.now() - last < 100 && !['failed', 'settled'].includes(info.state))) return;
    last = performance.now(); const c = info.coverage ?? {}, p = info.pending ?? {};
    node.textContent = `${info.label}: ${info.state}\n${info.waiting_reason}\nTiempo: ${info.elapsed_ms} ms\nTiles objetivo: ${c.expected ?? '?'}; cargados: ${c.loaded ?? '?'}; pendientes: ${c.pending ?? '?'}; sin evidencia: ${c.missing ?? '?'}\nCobertura: ${c.complete ? 'verificada' : 'no verificada'}\nWADO pendientes: ${p.wado_pending ?? '?'}\nProcesamiento posterior observable: ${p.processing_observable_pending ?? '?'}\nOperaciones desconocidas: ${p.unknown_operations ?? '?'}\nTiles previos pendientes: ${p.previous_region_pending ?? '?'}`;
  } };
}

export function installBenchmarkV33(viewer, { client } = {}) {
  if (lockOwner() || window.oncometsBenchmarkV33?.isRunning()) return window.oncometsBenchmarkV33 ?? null;
  const map = viewer?.getMap?.(); if (!map?.getView) return null;
  let busy = false, last = null, panel, reloadRequired = false;
  const control = { cancelled: false };
  const setView = (center, resolution) => { map.getView().setResolution(resolution); map.getView().setCenter(center); };
  async function run(options = {}) {
    const c = settings(options);
    if (reloadRequired) throw Error('Residual work was not verified; reload before another benchmark.');
    return withBenchmarkLock('V3.3', async () => {
      busy = true; control.cancelled = false;
      let session, original;
      const result = { instrument: 'OncoMETS WSI navigation benchmark', version: '3.3', schema_version: 3,
        implementation_revision: 'terminal-transition-barrier-1', protocol: 'technical-coverage-navigation-v1',
        settings: c, started_at: new Date().toISOString(), cache_cleared_by_instrument: false,
        clinical_visual_completeness: 'not_verified', runs: [], preparation: {}, status: 'failed',
        caveats: ['Coverage and renderer evidence are technical proxies, not clinical visual completeness.',
          'Processing after WADO includes scheduling, decode and transformations; decoder-only timing is unavailable.',
          'Unobserved pre-existing operations and renderer cache may prevent verification.',
          'No request is aborted by stopping this protocol. Preparation may warm caches.'] };
      try {
        if (map.getTargetElement()?.id !== 'viewport' || document.querySelectorAll('#viewport > .ol-viewport').length !== 1 ||
            document.hidden || map.getSize().some(x => x < 100)) throw Error('Invalid environment.');
        original = captureTarget(map); result.viewport_css_px = original.size; result.device_pixel_ratio = window.devicePixelRatio;
        panel?.close(); panel = diagnosticPanel(c.debug);
        session = createSession({ map, client });
        const measure = (label, change, classification, repetition, allowNoMovement = false) => measureStep({ map, session, change, label,
          classification, repetition, allowNoMovement, c, control, debug: info => panel.update(info) });
        const initial = await drain(session, map, c.timeoutMs, c.quietMs, wait, { control }); result.preparation.initial_drain = initial;
        if (control.cancelled) { result.status = 'cancelled'; return result; }
        if (initial.status !== 'drained') { result.termination_reason = initial.reason ?? 'initial_drain_timeout'; return result; }
        const center = original.rawCenter, initialRes = original.resolution;
        let base, res, dx, dy;
        // Constraint probes are synchronous and never render intermediate candidates.
        for (let attempt = 0, candidate = initialRes / c.preZoomFactor; attempt < c.maxZoomSteps; attempt++) {
          setView(center, candidate); res = map.getView().getResolution(); base = [...map.getView().getCenter()];
          const possible = (x, y) => {
            setView([base[0] + x, base[1] + y], res);
            const ok = same(map.getView().getCenter(), [base[0] + x, base[1] + y]) && near(map.getView().getResolution(), res);
            setView(base, res); return ok;
          };
          dx = map.getSize()[0] * res * c.panFraction; dy = -map.getSize()[1] * res * c.panFraction;
          if (!possible(dx, 0)) dx = -dx; if (!possible(0, dy)) dy = -dy;
          if (initialRes / res >= c.minimumActualZoomFactor && possible(dx, 0) && possible(0, dy) && possible(dx, dy)) break;
          base = null; candidate = res / c.additionalZoomFactor;
        }
        if (!base) throw Error('Preparation failed.');
        const prep = await measure('preparation', () => setView(base, res), 'setup', 0, true);
        result.preparation.settling = prep; result.preparation.achieved_zoom_factor = round(initialRes / res);
        if (prep.terminal_state !== 'completed') { result.status = prep.terminal_state; result.termination_reason = prep.termination_reason; return result; }
        await wait(c.preparationWaitMs);
        const actions = [
          ['pan-new-horizontal', 'new-region-candidate', () => setView([base[0] + dx, base[1]], res)],
          ['pan-new-diagonal', 'new-region-candidate', () => setView([base[0] + dx, base[1] + dy], res)],
          ['pan-new-vertical', 'new-region-candidate', () => setView([base[0], base[1] + dy], res)],
          ['pan-return-base', 'revisit', () => setView(base, res)],
          ['pan-revisit-horizontal', 'revisit', () => setView([base[0] + dx, base[1]], res)],
          ['pan-return-base-again', 'revisit', () => setView(base, res)],
          ['zoom-in', 'zoom-new-detail', () => setView(base, res / c.zoomFactor)],
          ['zoom-out-return', 'revisit', () => setView(base, res)] ];
        for (let rep = 1; rep <= c.repetitions; rep++) {
          const start = await measure('repetition-entry', undefined, 'barrier', rep, true);
          if (start.terminal_state !== 'completed') {
            result.status = start.terminal_state; result.transition_failure = start;
            if (result.runs.length) revokeCompletion(result.runs.at(-1), start);
            break;
          }
          const execution = await executeProtocol(actions, ([label, classification, change]) => measure(label, change, classification, rep),
            row => measure(`transition-after-${row.label}`, undefined, 'barrier', rep, true), () => wait(c.betweenStepsMs));
          result.runs.push(...execution.rows); result.status = execution.status;
          if (execution.status !== 'completed') { result.termination_reason = execution.rows.at(-1)?.transition?.termination_reason ?? execution.rows.at(-1)?.termination_reason; break; }
        }
      } catch { result.status = 'failed'; result.termination_reason = 'instrumentation_or_preparation_failure'; }
      finally {
        try {
          if (session) {
            result.cleanup = { before_restore: await drain(session, map, c.cleanupTimeoutMs, Math.min(c.quietMs, c.cleanupTimeoutMs), wait, { ignoreErrors: true }) };
            if (result.cleanup.before_restore.status !== 'drained' && result.runs.at(-1)?.terminal_state === 'completed') {
              revokeCompletion(result.runs.at(-1), { terminal_state: 'failed', validity: 'invalid',
                termination_reason: 'post_protocol_drain_timeout', residual_operations: result.cleanup.before_restore.residual });
            }
            if (result.cleanup.before_restore.status === 'drained' && original) {
              setView(original.rawCenter, original.resolution);
              result.cleanup.after_restore = await drain(session, map, c.cleanupTimeoutMs, Math.min(c.quietMs, c.cleanupTimeoutMs), wait, { ignoreErrors: true });
              result.cleanup.view_restored = true;
            } else result.cleanup.view_restored = false;
            reloadRequired = result.cleanup.before_restore.status !== 'drained' || result.cleanup.after_restore?.status !== 'drained';
          }
        } catch { result.cleanup = { status: 'cleanup_failed', requests_cancelled: false }; reloadRequired = true; }
        finally { session?.close(); busy = false; }
        result.reload_required = reloadRequired; result.finished_at = new Date().toISOString();
        if (reloadRequired && result.status === 'completed') { result.status = 'failed'; result.termination_reason = 'cleanup_residual_work'; }
        result.summary_by_step = summarize(result.runs); last = result;
      }
      return result;
    });
  }
  const api = { run, cancel: () => { control.cancelled = true; }, isRunning: () => busy, getResults: () => last,
    disableDebug: () => panel?.close(), destroy: () => { control.cancelled = true; panel?.close(); },
    download: () => {
      if (!last || busy) throw Error('Finish V3.3 before exporting.');
      const url = URL.createObjectURL(new Blob([JSON.stringify(last, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `oncomets-benchmark-v33-${Date.now()}.json`;
      a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); return last;
    } };
  window.oncometsBenchmarkV33 = api; return api;
}
