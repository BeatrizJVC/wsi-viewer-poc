import { getPointResolution } from 'ol/proj.js';
import { renderModelResults } from './model-results.js';
import './viewer-tools.css';

export function renderViewerTools({ viewer, context }) {
  const { caseId, seriesUID } = context;
  const viewport = document.getElementById('viewport');
  const map = viewer.getMap();
  const view = map.getView();
  const initial = { center: view.getCenter()?.slice(), resolution: view.getResolution(), rotation: view.getRotation() };
  const toolbar = document.createElement('div');
  toolbar.className = 'viewer-tools'; toolbar.setAttribute('aria-label', 'Herramientas del visor'); toolbar.setAttribute('role', 'toolbar');
  const message = document.createElement('p'); message.className = 'tool-status'; message.setAttribute('role', 'status');
  function button(label, action) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', () => { try { action(b); } catch (e) { message.textContent = e.message; } });
    toolbar.append(b); return b;
  }
  const modes = [];
  function mode(label, activate) {
    const b = button(label, () => {
      viewer.deactivateDrawInteraction(); viewer.deactivateModifyInteraction(); viewer.deactivateDragZoomInteraction(); viewer.deactivateDragPanInteraction();
      activate(); modes.forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      message.textContent = label.includes('ROI') ? 'Dibuje sobre la lámina. Doble clic para terminar polígonos. Las anotaciones son temporales; expórtelas antes de cambiar de lámina.' : label;
    });
    b.setAttribute('aria-pressed', 'false'); modes.push(b);
  }
  mode('Desplazar', () => viewer.activateDragPanInteraction());
  mode('Zoom por arrastre', () => viewer.activateDragZoomInteraction());
  button('− Alejar', () => view.animate({ zoom: view.getZoom() - 1, duration: 150 }));
  button('+ Acercar', () => view.animate({ zoom: view.getZoom() + 1, duration: 150 }));
  mode('ROI rectangular', () => viewer.activateDrawInteraction({ geometryType: 'box' }));
  mode('ROI polígono', () => viewer.activateDrawInteraction({ geometryType: 'polygon' }));
  mode('Medir distancia', () => viewer.activateDrawInteraction({ geometryType: 'line', maxPoints: 2, markup: 'measurement' }));
  mode('Editar ROI', () => viewer.activateModifyInteraction());
  let visible = true;
  button('Anotaciones', b => { visible = !visible; visible ? viewer.showROIs() : viewer.hideROIs(); b.setAttribute('aria-pressed', String(visible)); }).setAttribute('aria-pressed', 'true');
  button('Rotar 90°', () => view.animate({ rotation: view.getRotation() + Math.PI / 2 }));
  button('Restablecer vista', () => view.animate({ ...initial, duration: 150 }));
  button('Exportar ROI JSON', () => {
    const blob = new Blob([JSON.stringify({ caseId, seriesUID, coordinateSystem: 'DICOM slide coordinates (mm)', rois: viewer.getAllROIs().map(roi => ({ uid: roi.uid, properties: roi.properties, scoord3d: { graphicType: roi.scoord3d.graphicType, graphicData: roi.scoord3d.graphicData, frameOfReferenceUID: roi.scoord3d.frameOfReferenceUID } })) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'anotaciones-wsi.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const output = document.createElement('output'); toolbar.append(output);
  const update = () => { const microns = getPointResolution(view.getProjection(), view.getResolution(), view.getCenter(), 'm') * 1e6; output.textContent = `Zoom ${view.getZoom().toFixed(1)} · ${Number.isFinite(microns) ? microns.toFixed(2) + ' µm/píxel' : 'Escala no disponible'} · ${viewer.numberOfROIs} ROI`; };
  map.on('moveend', update); map.on('rendercomplete', update); update();
  viewport.before(toolbar, message);
  const layout = document.createElement('div'); layout.className = 'viewer-layout'; viewport.before(layout); layout.append(viewport);
  renderModelResults({ container: layout, context });
  map.updateSize();
  viewer.activateDragPanInteraction(); modes[0].setAttribute('aria-pressed', 'true');
}
