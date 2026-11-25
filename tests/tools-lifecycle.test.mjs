import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureInteractionState,
  createToolsDisposer,
  mountAroundContainer,
  restoreInteractionState,
} from '../src/wsi/tools-lifecycle.js';

// DOM mínimo con la semántica de nodos que usa el módulo.
class FakeNode {
  constructor(name) { this.name = name; this.parentNode = null; this.children = []; }
  get nextSibling() {
    const parent = this.parentNode;
    if (!parent) return null;
    return parent.children[parent.children.indexOf(this) + 1] ?? null;
  }
  appendChild(child) {
    child.parentNode?.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('NotFoundError: not a child');
    this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  insertBefore(child, reference) {
    if (reference === null) return this.appendChild(child);
    if (reference.parentNode !== this) throw new Error('NotFoundError: reference is not a child');
    child.parentNode?.removeChild(child);
    this.children.splice(this.children.indexOf(reference), 0, child);
    child.parentNode = this;
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
}

const names = node => node.children.map(child => child.name);

function fakeViewer(initial = {}) {
  const calls = [];
  const state = { draw: false, modify: false, dragZoom: false, dragPan: true, rois: true, ...initial };
  const viewer = {
    calls,
    state,
    get isDrawInteractionActive() { return state.draw; },
    get isModifyInteractionActive() { return state.modify; },
    get isDragZoomInteractionActive() { return state.dragZoom; },
    get isDragPanInteractionActive() { return state.dragPan; },
    get areROIsVisible() { return state.rois; },
  };
  for (const name of ['Draw', 'Modify', 'DragZoom', 'DragPan']) {
    const key = name[0].toLowerCase() + name.slice(1);
    viewer[`activate${name}Interaction`] = () => { calls.push(`activate${name}`); state[key] = true; };
    viewer[`deactivate${name}Interaction`] = () => { calls.push(`deactivate${name}`); state[key] = false; };
  }
  viewer.showROIs = () => { calls.push('showROIs'); state.rois = true; };
  viewer.hideROIs = () => { calls.push('hideROIs'); state.rois = false; };
  return viewer;
}

function fakeMap(container) {
  const listeners = new Set();
  return {
    listeners,
    updateSizeCalls: 0,
    target: container,
    on(type, listener) { const key = { type, listener }; listeners.add(key); return key; },
    getTargetElement() { return this.target; },
    updateSize() { this.updateSizeCalls++; },
  };
}

const unByKey = map => keys => { for (const key of [].concat(keys)) map.listeners.delete(key); };

// Reproduce el montaje que hace renderViewerTools.
function setup({ initial, withNextSibling = true } = {}) {
  const parent = new FakeNode('app');
  const header = new FakeNode('header');
  const container = new FakeNode('viewport');
  const footer = new FakeNode('footer');
  parent.appendChild(header);
  parent.appendChild(container);
  if (withNextSibling) parent.appendChild(footer);

  const viewer = fakeViewer(initial);
  const map = fakeMap(container);
  const interactionState = captureInteractionState(viewer);
  const listenerKeys = [map.on('moveend', () => {}), map.on('rendercomplete', () => {})];
  const toolbar = new FakeNode('toolbar');
  const message = new FakeNode('message');
  const layout = new FakeNode('layout');
  const restoreLayout = mountAroundContainer(container, { leading: [toolbar, message], layout });

  // Efectos típicos del uso de las herramientas.
  viewer.deactivateDragPanInteraction();
  viewer.activateDrawInteraction();
  viewer.hideROIs();
  viewer.calls.length = 0;

  const dispose = createToolsDisposer({
    map, viewer, container, listenerKeys, unByKey: unByKey(map), interactionState, restoreLayout,
  });
  return { parent, header, container, footer, viewer, map, toolbar, message, layout, dispose };
}

test('el montaje deja barra, mensaje y layout en la posición del contenedor', () => {
  const { parent, layout } = setup();
  assert.deepEqual(names(parent), ['header', 'toolbar', 'message', 'layout', 'footer']);
  assert.deepEqual(names(layout), ['viewport']);
});

test('dispose una vez: listeners, interacciones, contenedor, nodos y updateSize', () => {
  const { parent, container, viewer, map, toolbar, message, layout, dispose } = setup();
  assert.equal(map.listeners.size, 2);

  assert.deepEqual(dispose(), []);

  assert.equal(map.listeners.size, 0, 'listeners retirados');
  assert.deepEqual(names(parent), ['header', 'viewport', 'footer'], 'contenedor en su lugar original');
  assert.equal(container.parentNode, parent);
  for (const node of [toolbar, message, layout]) assert.equal(node.parentNode, null);
  assert.deepEqual(viewer.calls, [
    'deactivateDraw', 'deactivateModify', 'deactivateDragZoom', 'deactivateDragPan',
    'activateDragPan', 'showROIs',
  ]);
  assert.deepEqual(
    { draw: viewer.state.draw, modify: viewer.state.modify, dragZoom: viewer.state.dragZoom, dragPan: viewer.state.dragPan, rois: viewer.state.rois },
    { draw: false, modify: false, dragZoom: false, dragPan: true, rois: true },
    'estado previo a las herramientas'
  );
  assert.equal(map.updateSizeCalls, 1);
});

test('dispose varias veces no repite efectos ni lanza', () => {
  const { parent, viewer, map, dispose } = setup();
  dispose();
  const callsAfterFirst = viewer.calls.length;
  assert.deepEqual(dispose(), []);
  assert.deepEqual(dispose(), []);
  assert.equal(viewer.calls.length, callsAfterFirst);
  assert.equal(map.updateSizeCalls, 1);
  assert.deepEqual(names(parent), ['header', 'viewport', 'footer']);
});

test('sin hermano original en el DOM, el contenedor ocupa el lugar del layout', () => {
  const { parent, footer, container, dispose } = setup();
  footer.remove();
  assert.deepEqual(dispose(), []);
  assert.deepEqual(names(parent), ['header', 'viewport']);
  assert.equal(container.parentNode, parent);
});

test('contenedor que era el último hijo vuelve al final', () => {
  const { parent, dispose } = setup({ withNextSibling: false });
  assert.deepEqual(dispose(), []);
  assert.deepEqual(names(parent), ['header', 'viewport']);
});

test('sin hermano ni layout en el DOM, el contenedor vuelve al padre original', () => {
  const { parent, footer, layout, container, dispose } = setup();
  footer.remove();
  layout.remove();
  assert.deepEqual(dispose(), []);
  assert.equal(container.parentNode, parent);
  assert.deepEqual(names(parent), ['header', 'viewport']);
});

test('si falla insertBefore junto al hermano original, se usa el lugar del layout', () => {
  const { parent, footer, container, toolbar, message, layout, viewer, map, dispose } = setup();
  const failure = new Error('insertBefore failed');
  const originalInsertBefore = parent.insertBefore;
  parent.insertBefore = function (child, reference) {
    if (reference === footer) throw failure;
    return originalInsertBefore.call(this, child, reference);
  };
  const errors = dispose();
  parent.insertBefore = originalInsertBefore;

  assert.deepEqual(errors, [failure]);
  assert.equal(container.parentNode, parent, 'el contenedor sigue en el DOM');
  assert.deepEqual(names(parent), ['header', 'viewport', 'footer']);
  for (const node of [toolbar, message, layout]) assert.equal(node.parentNode, null);
  assert.equal(map.listeners.size, 0);
  assert.equal(viewer.state.dragPan, true);
  assert.equal(map.updateSizeCalls, 1);
});

test('si insertBefore falla siempre, el contenedor vuelve al padre con appendChild', () => {
  const { parent, container, toolbar, message, layout, map, dispose } = setup();
  const failure = new Error('insertBefore failed');
  const originalInsertBefore = parent.insertBefore;
  parent.insertBefore = () => { throw failure; };
  const errors = dispose();
  parent.insertBefore = originalInsertBefore;

  assert.deepEqual(errors, [failure, failure], 'se intentaron las dos alternativas con insertBefore');
  assert.equal(container.parentNode, parent, 'el contenedor sigue en el DOM');
  assert.deepEqual(names(parent), ['header', 'footer', 'viewport']);
  for (const node of [toolbar, message, layout]) assert.equal(node.parentNode, null);
  assert.equal(map.listeners.size, 0);
  assert.equal(map.updateSizeCalls, 1);
});

test('si todas las alternativas fallan, el layout se conserva y el contenedor no se desconecta', () => {
  const { parent, container, toolbar, message, layout, map, viewer, dispose } = setup();
  const failure = new Error('DOM failure');
  const originalInsertBefore = parent.insertBefore;
  const originalAppendChild = parent.appendChild;
  parent.insertBefore = () => { throw failure; };
  parent.appendChild = () => { throw failure; };
  const errors = dispose();
  parent.insertBefore = originalInsertBefore;
  parent.appendChild = originalAppendChild;

  assert.equal(errors.length, 4);
  assert.deepEqual(errors.slice(0, 3), [failure, failure, failure]);
  assert.match(errors[3].message, /layout se conserva/);
  assert.equal(container.parentNode, layout, 'el contenedor sigue dentro del layout');
  assert.equal(layout.parentNode, parent, 'el layout sigue en el DOM');
  assert.equal(toolbar.parentNode, null);
  assert.equal(message.parentNode, null);
  assert.equal(map.listeners.size, 0);
  assert.equal(viewer.state.draw, false);
  assert.deepEqual(dispose(), [], 'una segunda llamada no repite efectos');
});

test('no llama a updateSize si el mapa ya no apunta al contenedor', () => {
  const { map, dispose } = setup();
  map.target = undefined;
  assert.deepEqual(dispose(), []);
  assert.equal(map.updateSizeCalls, 0);
});

test('errores de interacciones y listeners se devuelven sin interrumpir la restauración', () => {
  const { parent, viewer, dispose } = setup();
  const failure = new Error('deactivate failed');
  viewer.deactivateModifyInteraction = () => { throw failure; };
  const errors = dispose();
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(names(parent), ['header', 'viewport', 'footer']);
});

test('restaura interacciones previas activas y no reactiva un dibujo previo', () => {
  const viewer = fakeViewer({ dragPan: false, dragZoom: true, modify: true, draw: true, rois: false });
  const state = captureInteractionState(viewer);
  viewer.showROIs();
  viewer.calls.length = 0;
  assert.deepEqual(restoreInteractionState(viewer, state), []);
  assert.deepEqual(viewer.calls, [
    'deactivateDraw', 'deactivateModify', 'deactivateDragZoom', 'deactivateDragPan',
    'activateDragZoom', 'activateModify', 'hideROIs',
  ]);
  assert.equal(viewer.state.draw, false);
});

test('el montaje exige un contenedor insertado en el DOM', () => {
  assert.throws(() => mountAroundContainer(new FakeNode('detached'), { layout: new FakeNode('layout') }), TypeError);
});
