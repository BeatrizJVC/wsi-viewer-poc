import { withBenchmarkLock } from './benchmark-run-lock.js';
/**
 * OncoMETS — deterministic, non-destructive viewer navigation benchmark.
 * Only changes the client-side OpenLayers View. Never calls FHIR/DICOM writes.
 * No clinical identifiers or viewport coordinates are included in exported results.
 */
const round = (v) => Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const memoryMB = () => round(performance.memory?.usedJSHeapSize / 1048576);
function quantile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const x = (sorted.length - 1) * p / 100;
  const l = Math.floor(x);
  return round(sorted[l] + (sorted[Math.ceil(x)] - sorted[l]) * (x - l));
}

export function createAutomaticBenchmark({ map, getResources, say, onUpdate }) {
  let running = false;
  let cancelled = false;
  const runs = [];
  const configuration = { passes: 2, repetitions: 2, panFraction: 0.35, zoomFactor: 1.5, quietMs: 350, timeoutMs: 12000 };
  let latestProtocol = null;

  async function oneStep({ label, phase, repetition, operation, startCenter, startResolution, size, cfg }) {
    if (cancelled) return null;
    const view = map.getView();
    const beforeCenter = [...view.getCenter()];
    const beforeResolution = view.getResolution();
    const start = performance.now();
    const heapStart = memoryMB();
    let nRender = 0;
    let firstRenderAt = null;
    let lastRenderAt = null;
    let nMoveEnd = 0;
    const onComplete = () => {
      const t = performance.now();
      nRender++;
      if (firstRenderAt === null) firstRenderAt = t;
      lastRenderAt = t;
    };
    const onMove = () => { nMoveEnd++; };
    map.on('rendercomplete', onComplete);
    map.on('moveend', onMove);
    try {
      // Only deterministic view changes; no simulated user DOM events.
      if (operation.kind === 'pan') {
        const dx = operation.dx * size[0] * startResolution;
        const dy = operation.dy * size[1] * startResolution;
        view.setCenter([startCenter[0] + dx, startCenter[1] + dy]);
      } else if (operation.kind === 'home') {
        view.setCenter([...startCenter]);
        view.setResolution(startResolution);
      } else if (operation.kind === 'zoom') {
        view.setCenter([...startCenter]);
        view.setResolution(startResolution / cfg.zoomFactor);
      }
      map.renderSync();
      const center = view.getCenter();
      const changed = Math.hypot(center[0]-beforeCenter[0], center[1]-beforeCenter[1]) > Math.max(1e-8,Math.abs(beforeResolution)*1e-5)
        || Math.abs(view.getResolution()-beforeResolution) > 1e-8;
      if (!changed) {
        return {
          label, phase, repetition, outcome:'no_view_change', timing_kind:'not_measured',
          rendercomplete_events:0, moveend_events:nMoveEnd, dicom_frames:0,
          note:'View constraints prevented a distinct movement; no timing computed.'
        };
      }
      let outcome='timeout_no_rendercomplete';
      while (performance.now()-start < cfg.timeoutMs && !cancelled) {
        await sleep(50);
        const now = performance.now();
        const related = getResources().filter(x => x.type === 'dicom-frame' && x.start >= start && x.start <= now);
        const lastNetwork = related.length ? Math.max(...related.map(x=>x.end ?? x.start)) : start;
        if (firstRenderAt !== null && now - Math.max(lastRenderAt ?? start, lastNetwork) >= cfg.quietMs) {
          outcome='rendercomplete_quiet';
          break;
        }
      }
      if (cancelled) outcome='cancelled';
      const end = performance.now();
      // Resource Timing entries may be reported a few milliseconds after response completion.
      await sleep(30);
      const frames = getResources().filter(x => x.type==='dicom-frame' && x.start>=start && x.start<=end);
      const levels = {};
      for (const f of frames) {
        const key = f.sop_level==null ? 'unknown' : `L${f.sop_level}`;
        levels[key] = (levels[key]||0)+1;
      }
      const latency = frames.map(f=>f.duration_ms);
      const sizesAvailable = frames.length > 0 && frames.every(f=>f.transfer_bytes!==null && f.transfer_bytes!==undefined);
      return {
        label, phase, repetition, outcome,
        timing_kind:outcome==='rendercomplete_quiet' ? 'openlayers_rendercomplete_plus_quiet' : 'incomplete',
        interaction_to_first_rendercomplete_ms:firstRenderAt===null?null:round(firstRenderAt-start),
        interaction_to_settled_ms:outcome==='rendercomplete_quiet'?round(end-start):null,
        elapsed_ms:round(end-start), rendercomplete_events:nRender, moveend_events:nMoveEnd,
        dicom_frames:frames.length, frame_levels:levels,
        frame_http_p50_ms:quantile(latency,50),frame_http_p95_ms:quantile(latency,95),
        transfer_bytes:sizesAvailable?frames.reduce((sum,f)=>sum+f.transfer_bytes,0):null,
        js_heap_start_mb:heapStart,js_heap_end_mb:memoryMB(),
      };
    } finally {
      map.un('rendercomplete', onComplete);
      map.un('moveend', onMove);
    }
  }

  async function run(options={}) {
    if (running) throw new Error('Ya hay un benchmark automático en ejecución.');
    if (!map || !map.getView()?.getCenter() || !map.getSize()?.every(n=>n>0))
      throw new Error('El mapa principal OpenLayers no está listo. Abre una WSI primero.');
    const cfg = {...configuration,...options};
    if (!Number.isInteger(cfg.passes)||cfg.passes<1||cfg.passes>5 ||
        !Number.isInteger(cfg.repetitions)||cfg.repetitions<1||cfg.repetitions>10 ||
        !(cfg.panFraction>0 && cfg.panFraction<=0.6) || !(cfg.zoomFactor>1 && cfg.zoomFactor<=3))
      throw new Error('Configuración inválida. passes:1–5, repetitions:1–10, panFraction:(0,0.6], zoomFactor:(1,3].');
    running=true; cancelled=false;
    runs.length=0;
    const view=map.getView();
    const startCenter=[...view.getCenter()];
    const startResolution=view.getResolution();
    const size=[...map.getSize()];
    latestProtocol={name:'fixed-view-positions-v1',...cfg,started_at:new Date().toISOString(),
      environment:'Record browser/page network separately; localhost vs Vercel are not interchangeable.',
      view_start:'Relative positions, center/resolution omitted for privacy.',
      steps_per_repetition:6};
    const operations=[
      {label:'pan-right',kind:'pan',dx:cfg.panFraction,dy:0},
      {label:'return-from-right',kind:'home'},
      {label:'pan-down',kind:'pan',dx:0,dy:-cfg.panFraction},
      {label:'return-from-down',kind:'home'},
      {label:'zoom-in',kind:'zoom'},
      {label:'zoom-out-return',kind:'home'}
    ];
    try {
      // Important: do NOT clear cache; pass 1 is 'first observed', not proven cold.
      for (let phase=1;phase<=cfg.passes&&!cancelled;phase++) {
        for(let repetition=1;repetition<=cfg.repetitions&&!cancelled;repetition++) {
          for (const operation of operations) {
            if(cancelled)break;
            say(`Automático: pasada ${phase}/${cfg.passes}, repetición ${repetition}/${cfg.repetitions} · ${operation.label}`);
            const r=await oneStep({label:operation.label, phase, repetition,operation,startCenter,startResolution,size,cfg});
            if(r) {runs.push(r);onUpdate?.(r,runs.length);}
            await sleep(150);
          }
        }
      }
      return getResults();
    } finally {
      // Re-establish the starting viewport even if cancelled, no persistent change.
      if(view.getCenter() && view.getResolution()) {
        view.setCenter(startCenter);view.setResolution(startResolution);
      }
      running=false;
      say(cancelled ? 'Benchmark automático cancelado. Puedes exportar el JSON.' : `Automático terminado: ${runs.length} pasos. Exporta el JSON.`);
    }
  }
  function getResults(){return runs.slice();}
  function stop(){cancelled=true;}
  return {run: (options) => withBenchmarkLock('V2-auto', () => run(options)), stop, getResults, get running(){return running;}, get protocol(){return latestProtocol;}};
}
