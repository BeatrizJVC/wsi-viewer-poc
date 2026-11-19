import { createAutomaticBenchmark } from './benchmark-auto.js';
import { acquireBenchmarkLock, lockOwner } from './benchmark-run-lock.js';
/**
 * OncoMETS Browser Benchmark V2 — exploratory, read-only.
 * OpenLayers rendercomplete is an exact render milestone ONLY when a Map is accessible.
 * Otherwise, "network-idle proxy" is NOT an exact TFOV metric.
 */
const QUIET_MS = 750;
const MAX_WAIT_MS = 30000;
const FRAME_RESOURCE_RE = /\/dicom-web\/.*\/frames\/\d+/i;

const n1 = (value) => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
const heapMB = () => n1(performance.memory?.usedJSHeapSize / 1024 / 1024);

function percentile(data, p) {
  const arr = data.filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return null;
  const at = (arr.length - 1) * p / 100;
  const left = Math.floor(at);
  return n1(arr[left] + (arr[Math.ceil(at)] - arr[left]) * (at - left));
}
function getCategory(url) {
  try {
    const path = new URL(url, location.origin).pathname;
    if (FRAME_RESOURCE_RE.test(path)) return 'dicom-frame';
    if (/\/dicom-web\/.*\/metadata(?:\/|$)/i.test(path)) return 'dicom-metadata';
    if (/\/dicom-web\//i.test(path)) return 'dicom-other';
    if (/\/fhir\//i.test(path)) return 'fhir';
    return 'other';
  } catch { return 'other'; }
}
function frameId(url) {
  try {
    const pathname = new URL(url, location.origin).pathname;
    return pathname.match(/\/instances\/([^/]+)\/frames\//i)?.[1] ?? null;
  } catch { return null; }
}
function isMap(m) {
  return Boolean(m && typeof m.on === 'function' && typeof m.un === 'function' &&
    typeof m.getView === 'function' && typeof m.getTargetElement === 'function');
}
function discoverMap(viewer) {
  const candidates = [viewer?.map, viewer?._map, viewer?.olMap, viewer?._olMap,
    viewer?.viewer?.map, viewer?._viewer?.map];
  for (const method of ['getMap', 'getOlMap']) {
    if (typeof viewer?.[method] === 'function') {
      try { candidates.push(viewer[method]()); } catch { /* nonpublic getter */ }
    }
  }
  return candidates.find(isMap) ?? null;
}
function sopMap(images) {
  const items = (images || []).map((item) => {
    const uid = item?.SOPInstanceUID;
    const cols = Number(item?.TotalPixelMatrixColumns ?? item?.totalPixelMatrixColumns ?? 0);
    const rows = Number(item?.TotalPixelMatrixRows ?? item?.totalPixelMatrixRows ?? 0);
    return { uid, area: cols * rows };
  }).filter(x => x.uid);
  items.sort((a,b) => b.area - a.area);
  return new Map(items.map((x,i) => [x.uid, i]));
}
function makeButton(text, action) {
  const b = document.createElement('button');
  b.type='button'; b.textContent=text; b.onclick=action;
  return b;
}
export function installViewerBenchmarkV2({ viewer, volumeImages = [], container = 'viewport' } = {}) {
  const enabled = import.meta.env.DEV || new URLSearchParams(location.search).get('benchmark') === '1';
  if (!enabled) return null;
  window.oncometsBenchmarkV2?.destroy?.();
  const target = document.getElementById(container);
  if (!target) { console.warn('[Benchmark V2] No existe #'+container); return null; }
  const map = discoverMap(viewer);
  const uidLevels = sopMap(volumeImages);
  let enabledRecording = true, active = null, gesture = null;
  let rafId, samplesTimer, evaluationTimer, resourceObserver, taskObserver;
  let lastRender = null, lastRenderAt = -Infinity;
  let listeners=[]; let session=[]; let longTasks = [];
  const mapEventCounts={rendercomplete:0,postrender:0,moveend:0};
  const mapEventHandlers=[];
  let resourceEvents=[]; let resourceKeys=new Set();
  let rafTimes=[]; let samples=[]; let mapRenderListener=null;
  const startedAt = performance.now();
  let automaticRunner = null;
  performance.setResourceTimingBufferSize(20000);
  const panel = document.createElement('div'); panel.className='oncomets-bench-v2';
  panel.innerHTML = '<strong>WSI Benchmark V2</strong><span class="wsi-bench-sub">Modo lectura · sin datos clínicos</span><div class="wsi-bench-state" aria-live="polite">Preparando…</div><div class="wsi-bench-buttons"></div><div class="wsi-bench-count"></div>';
  document.body.appendChild(panel);
  const state = panel.querySelector('.wsi-bench-state');
  const count = panel.querySelector('.wsi-bench-count');
  const buttons = panel.querySelector('.wsi-bench-buttons');
  const say=(t)=>{state.textContent=t};
  const updateCount=()=>{count.textContent=`${session.length} registros · ${resourceEvents.filter(x=>x.type==='dicom-frame').length} respuestas WADO observadas`};
  function listen(obj,event,fn,options){obj.addEventListener(event,fn,options);listeners.push(()=>obj.removeEventListener(event,fn,options))}
  function ingestResource(entry) {
    const key = `${entry.name}:${entry.startTime}:${entry.duration}`;
    if (resourceKeys.has(key)) return;
    resourceKeys.add(key);
    const type = getCategory(entry.name);
    if (type==='other') return;
    const uid=frameId(entry.name);
    const visibleTransfer = entry.transferSize > 0;
    resourceEvents.push({type, start:n1(entry.startTime), end:n1(entry.responseEnd),
      duration_ms:n1(entry.duration), transfer_bytes:visibleTransfer?entry.transferSize:null,
      sop_level:uid ? (uidLevels.get(uid) ?? null) : null});
  }
  performance.getEntriesByType('resource').forEach(ingestResource);
  try { resourceObserver=new PerformanceObserver(list=>list.getEntries().forEach(ingestResource));resourceObserver.observe({type:'resource',buffered:false}) } catch(e){console.warn('[Benchmark V2] Resource observer no disponible',e)}
  try {taskObserver=new PerformanceObserver(list=>{
    list.getEntries().forEach(e=>longTasks.push({start:e.startTime, duration:e.duration}));
  });taskObserver.observe({type:'longtask'})}catch{/* no disponible */}
  function tick(t){rafTimes.push(t);if(rafTimes.length>30000)rafTimes.shift();rafId=requestAnimationFrame(tick)}
  rafId=requestAnimationFrame(tick);
  samplesTimer=setInterval(()=>{
    samples.push({t:n1(performance.now()), heap_mb:heapMB()});
    if(samples.length>12000) samples.shift();
  },1000);
  samples.push({t:n1(performance.now()),heap_mb:heapMB()});

  function begin(label,started) {
    if(!enabledRecording || automaticRunner?.running || (lockOwner() && !active))return;
    if(active) finish('interrupted');
    lastRender=null;lastRenderAt=-Infinity;
    active={releaseLock:acquireBenchmarkLock('V2-manual'),label, start:started??performance.now(), lastInput:performance.now(),
      startHeap:heapMB(), afterInteraction:false,
      mapCountsAtStart:{...mapEventCounts}};
    say(`Midiendo ${label}…`);
  }
  function inputEnd() {if(active){active.lastInput=performance.now();active.afterInteraction=true}}
  function frameResources(a,end) {return resourceEvents.filter(e=>e.type==='dicom-frame'&&e.start>=a.start&&e.start<=end)}
  function finish(reason) {
    if(!active)return;
    const a=active;const end=performance.now();active=null;
    a.releaseLock();
    const rs=resourceEvents.filter(r=>r.start>=a.start&&r.start<=end);
    const frames=rs.filter(r=>r.type==='dicom-frame');
    const levels={};for(const f of frames)levels[f.sop_level==null?'unknown':`L${f.sop_level}`]=(levels[f.sop_level==null?'unknown':`L${f.sop_level}`]||0)+1;
    const timings=rafTimes.filter(t=>t>=a.start&&t<=end);
    const deltas=timings.slice(1).map((t,i)=>t-timings[i]);
    const observedRender = reason==='rendercomplete' && lastRenderAt>=a.lastInput;
    const record={
      label:a.label,
      timing_kind:observedRender?'openlayers_rendercomplete':reason==='interrupted'?'incomplete':'network_quiet_proxy',
      map_events_during_run:Object.fromEntries(Object.entries(mapEventCounts).map(([k,v])=>[k,v-a.mapCountsAtStart[k]])),
      outcome:reason,
      duration_ms:n1(end-a.start),
      interaction_to_complete_ms:n1(end-a.lastInput),
      dicom_frames:frames.length,
      frame_levels:levels,
      dicom_metadata:rs.filter(r=>r.type==='dicom-metadata').length,
      fhir_requests:rs.filter(r=>r.type==='fhir').length,
      frame_http_duration_p50_ms:percentile(frames.map(f=>f.duration_ms),50),
      frame_http_duration_p95_ms:percentile(frames.map(f=>f.duration_ms),95),
      bytes_visible_sum:frames.length&&frames.every(f=>f.transfer_bytes!==null)?frames.reduce((a,b)=>a+b.transfer_bytes,0):null,
      task_count:longTasks.filter(x=>x.start>=a.start&&x.start<=end).length,
      raf_interval_p95_ms:percentile(deltas,95),
      raf_intervals_over_50ms:deltas.filter(x=>x>50).length,
      js_heap_start_mb:a.startHeap,
      js_heap_end_mb:heapMB(),
    };
    session.push(record);updateCount();
    say(`${a.label}: ${record.duration_ms} ms · ${record.dicom_frames} frames · ${record.timing_kind==='openlayers_rendercomplete'?'rendercomplete':'proxy'}`);
    console.table([record]);
    return record;
  }
  if(map){
    mapRenderListener=()=>{mapEventCounts.rendercomplete++;lastRenderAt=performance.now();lastRender=true};
    map.on('rendercomplete',mapRenderListener);
    const onPostRender=()=>{mapEventCounts.postrender++};
    const onMoveEnd=()=>{mapEventCounts.moveend++};
    map.on('postrender',onPostRender);map.on('moveend',onMoveEnd);
    mapEventHandlers.push(['postrender',onPostRender],['moveend',onMoveEnd]);
    say('OpenLayers detectado: rendercomplete + requests');
  } else say('OpenLayers no accesible: proxy de red (no TFOV exacto)');
  const poll=()=>{
    if(!active||!active.afterInteraction)return;
    const now=performance.now();
    const start=active.start;
    const relevant=resourceEvents.filter(x=>x.start>=start&&x.type==='dicom-frame');
    const lastNet=Math.max(active.lastInput,...relevant.map(x=>x.end));
    if(map&&lastRender&&lastRenderAt>=active.lastInput&&now-lastRenderAt>=100&&now-active.lastInput>=250){finish('rendercomplete');return;}
    if(now-lastNet>QUIET_MS&&now-active.lastInput>QUIET_MS)finish(map?'timeout_network_quiet_without_rendercomplete':'network_quiet');
    else if(now-start>MAX_WAIT_MS)finish('timeout_30s');
  };
  evaluationTimer=setInterval(poll,100);
  let pointerStart=null;
  listen(target,'pointerdown',ev=>{if(ev.button!==0)return;pointerStart={x:ev.clientX,y:ev.clientY,t:performance.now()};},true);
  listen(target,'pointerup',ev=>{
    if(!pointerStart)return;
    const p=pointerStart;pointerStart=null;
    const distance=Math.hypot(ev.clientX-p.x,ev.clientY-p.y);
    if(distance<12)return;
    begin('pan',p.t);inputEnd();
  },true);
  let lastWheelAt=0;
  listen(target,'wheel',ev=>{
    const now=performance.now();
    if(now-lastWheelAt>450 || !active || !active.label.startsWith('zoom'))begin(ev.deltaY<0?'zoom-in':'zoom-out',now);
    lastWheelAt=now;inputEnd();
  },{passive:true,capture:true});
  listen(target,'dblclick',()=>{begin('zoom-doubleclick',performance.now());inputEnd()},true);
  listen(document,'click',ev=>{
    const btn=ev.target.closest?.('.ol-zoom-in,.ol-zoom-out');
    if(!btn)return;
    begin(btn.matches('.ol-zoom-in')?'zoom-in-button':'zoom-out-button',performance.now());inputEnd();
  },true);
  listen(document,'keydown',ev=>{
    if(/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||''))return;
    if(['+','=','-','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(ev.key)){
      begin(ev.key.startsWith('Arrow')?'keyboard-pan':'keyboard-zoom',performance.now());inputEnd();
    }
  },true);
  function exportData(){
    const body={instrument:'OncoMETS Browser Benchmark V2 + automatic protocol V3',version:3,created_at:new Date().toISOString(),
      automatic_protocol:automaticRunner?.protocol ?? null, automatic_runs:automaticRunner?.getResults() ?? [],
      map_detected:!!map,rendercomplete_observed:mapEventCounts.rendercomplete>0,map_event_counts:{...mapEventCounts},viewport:`${innerWidth}x${innerHeight}`,record_count:session.length,
      runs:session, memory_samples:samples.filter((_,i)=>i%5===0).map(x=>({time_offset_ms:n1(x.t-startedAt),js_heap_mb:x.heap_mb})),
      caveats:['network_quiet_proxy no equivale a TFOV clínico ni a una imagen completamente visible',
       'rendercomplete solo se utiliza si existe acceso a un Map de OpenLayers',
       'transferSize sin Timing-Allow-Origin puede estar oculto: null no es cero bytes',
       'duración HTTP de múltiples requests concurrentes no se suma para estimar tiempo visual',
       'JS heap no equivale a memoria RAM, caché gráfica ni memoria GPU',
       'No se capturan automáticamente apertura de caso ni cambio de lámina en esta versión']};
    const b=new Blob([JSON.stringify(body,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(b);const a=document.createElement('a');a.href=url;a.download=`oncomets-benchmark-v2-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
    say('Datos exportados (sin IDs DICOM ni URLs)');
  }
  function mark(label='memory-checkpoint'){
    session.push({label,timing_kind:'checkpoint',outcome:'manual',js_heap_mb:heapMB(),t_offset_ms:n1(performance.now()-startedAt)});
    updateCount();say(`Checkpoint: ${label}`);
  }
  function destroy(){
    active?.releaseLock();active=null;
    automaticRunner?.stop();
    resourceObserver?.disconnect();taskObserver?.disconnect();clearInterval(samplesTimer);clearInterval(evaluationTimer);cancelAnimationFrame(rafId);
    if(map&&mapRenderListener)map.un('rendercomplete',mapRenderListener);
    if(map)for(const [event,handler] of mapEventHandlers)map.un(event,handler);
    listeners.forEach(f=>f());panel.remove();if(window.oncometsBenchmarkV2===api)delete window.oncometsBenchmarkV2;
  }
  automaticRunner = createAutomaticBenchmark({map,getResources:()=>resourceEvents,say,onUpdate:(record,n)=>{
    updateCount();say(`Auto ${n}: ${record.label} · ${record.interaction_to_settled_ms ?? 'sin confirmación'} ms · ${record.dicom_frames} frames`);
    console.info('[Benchmark Auto]',record);
  }});
  buttons.append(makeButton('▶ Automático',()=>{
      automaticRunner.run().catch(e=>{console.error('[Benchmark Auto]',e);say(`Error automático: ${e.message}`)});
    }),makeButton('■ Cancelar auto',()=>automaticRunner.stop()),
    makeButton('↓ Exportar JSON',exportData),makeButton('● Memoria',()=>mark()),makeButton('Detener',()=>{enabledRecording=false;if(active)finish('stopped');say('Detenido: exporta el JSON')}),makeButton('Cerrar',destroy));
  const api={export:exportData,mark,finish,stop:()=>{enabledRecording=false;if(active)finish('stopped')},destroy,runAutomatic:(opts)=>automaticRunner.run(opts),stopAutomatic:()=>automaticRunner.stop(),getAutomaticResults:()=>automaticRunner.getResults(),getResults:()=>session.slice(),mapDetected:!!map,getMapDiagnostics:()=>({mapDetected:!!map,eventCounts:{...mapEventCounts},targetConnected:!!map?.getTargetElement?.()?.isConnected})};
  api.isRunning=()=>!!active || !!automaticRunner?.running;
  window.oncometsBenchmarkV2=api;
  updateCount();
  console.info('[Benchmark V2] Activado. Map OpenLayers:',!!map,'| Control:',api);
  return api;
}
