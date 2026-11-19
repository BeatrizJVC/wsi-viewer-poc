import { getRotatedViewport } from 'ol/extent.js';
// No DOM, network, pixel reads or clinical metadata in this module.
export const round = n => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
export function percentile(values, p) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const k = (a.length - 1) * p, i = Math.floor(k);
  return round(a[i] + (a[Math.ceil(k)] - a[i]) * (k - i));
}
export const tileKey = (z, x, y) => `${z}/${x}/${y}`;
const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

// Convex viewport clipped against axis-aligned layer/image/tile bounds.
// Positive area excludes cells that only touch the viewport at an edge/corner.
function clippedArea(polygon, bounds) {
  let p = polygon;
  for (const [axis, bound, sign] of [[0, bounds[0], 1], [0, bounds[2], -1], [1, bounds[1], 1], [1, bounds[3], -1]]) {
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const ai = sign * (a[axis] - bound) >= 0, bi = sign * (b[axis] - bound) >= 0;
      if (ai) out.push(a);
      if (ai !== bi) {
        const t = (bound - a[axis]) / (b[axis] - a[axis]);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    p = out;
  }
  if (p.length < 3) return 0;
  // Translate before shoelace sum to avoid cancellation at large map coordinates.
  const [ox, oy] = p[0];
  return Math.abs(p.reduce((sum, a, i) => {
    const b = p[(i + 1) % p.length];
    return sum + (a[0] - ox) * (b[1] - oy) - (b[0] - ox) * (a[1] - oy);
  }, 0)) / 2;
}

// Expected grid cells come from geometry, NEVER from observed getTile calls.
// Same-projection tile layers; geometric rotation is supported without rotating the View.
export function expectedCoverage(map, registry, maxTiles = 10000, fixedView = null) {
  const v = fixedView ?? map.getView(), resolution = v.getResolution(), projection = v.getProjection();
  const rotation = v.getRotation(), center = v.getState?.().center ?? v.getCenter(), size = map.getSize();
  if (!Number.isFinite(rotation) || !Number.isFinite(resolution) || resolution <= 0 ||
      !center?.every(Number.isFinite) || !size?.every(n => Number.isFinite(n) && n > 0)) {
    return { established: false, reason: 'invalid_view_geometry', rotation_radians: Number.isFinite(rotation) ? rotation : null };
  }
  const flat = getRotatedViewport(center, resolution, rotation, size);
  const polygon = Array.from({ length: 4 }, (_, i) => flat.slice(i * 2, i * 2 + 2));
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
  const envelope = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  let expected = 0, loaded = 0, missing = 0, errors = 0, pending = 0;
  const levels = [], signature = [], members = [];
  let unsupported = false;
  function visit(group, extent, visible = true) {
    for (const layer of group.getLayers().getArray()) {
      const on = visible && layer.getVisible() && layer.getOpacity() > 0 &&
        resolution >= layer.getMinResolution() && resolution < layer.getMaxResolution() &&
        v.getZoom() > layer.getMinZoom() && v.getZoom() <= layer.getMaxZoom();
      if (!on) continue;
      const clip = layer.getExtent() ? intersect(extent, layer.getExtent()) : extent;
      if (clip[0] >= clip[2] || clip[1] >= clip[3]) continue;
      if (layer.getLayers) { visit(layer, clip, on); continue; }
      const source = layer.getSource?.();
      if (source?.getFeatures) continue; // Annotation vectors do not contribute raster tile coverage.
      if (!source?.getTileGrid) { unsupported = true; continue; }
      const sp = source.getProjection?.();
      if ((sp && sp.getCode() !== projection.getCode()) || source.getWrapX?.() || source.transformMatrix) {
        unsupported = true; continue;
      }
      const grid = source.getTileGrid();
      const bounds = grid?.getExtent();
      if (!bounds || source.getState?.() !== 'ready') { unsupported = true; continue; }
      const e = intersect(clip, bounds);
      if (e[0] >= e[2] || e[1] >= e[3]) continue;
      const z = grid.getZForResolution(resolution, source.zDirection);
      const range = grid.getTileRangeForExtentAndZ(e, z), full = grid.getFullTileRange(z);
      if (!full) { unsupported = true; continue; }
      const minX = Math.max(range.minX, full.minX), maxX = Math.min(range.maxX, full.maxX);
      const minY = Math.max(range.minY, full.minY), maxY = Math.min(range.maxY, full.maxY);
      levels.push(z);
      const state = registry.get(source);
      signature.push([state?.id, source.getRevision(), z, minX, maxX, minY, maxY]);
      const count = Math.max(0, maxX - minX + 1) * Math.max(0, maxY - minY + 1);
      if (expected + count > maxTiles) { unsupported = true; continue; }
      for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
        const cell = intersect(e, grid.getTileCoordExtent([z, x, y]));
        if (cell[0] >= cell[2] || cell[1] >= cell[3]) continue;
        const area = clippedArea(polygon, cell);
        if (area <= Number.EPSILON * 64 * (cell[2] - cell[0]) * (cell[3] - cell[1])) continue;
        expected++;
        members.push({ source, key: tileKey(z, x, y) });
        const entry = state?.tiles.get(tileKey(z, x, y));
        if (!entry || entry.sourceKey !== source.getKey()) { missing++; continue; }
        const s = entry.ref?.deref()?.getState();
        if (s === 2) loaded++;
        else if (s === 3) errors++;
        else if (s === 0 || s === 1) pending++;
        else missing++; // null / EMPTY cannot prove a legitimate sparse hole.
      }
    }
  }
  visit(map, envelope);
  return { established: !unsupported && expected > 0 && missing === 0,
    reason: unsupported ? 'unsupported_visible_layer' : !expected ? 'empty_visible_extent' : missing ? 'unobserved_or_absent_tiles' : null,
    expected, loaded, missing, errors, pending, levels, rotation_radians: rotation,
    geometry_method: 'rotated_viewport_polygon_clipped_to_layer_image_and_tile',
    complete: !unsupported && expected > 0 && loaded === expected,
    signature: JSON.stringify([signature, members.map(m => [registry.get(m.source)?.id, m.key])]), members };
}

export function instrumentSources(map, activity, stepToken = () => null, hooks = {}) {
  const registry = new Map(), cleanup = [];
  const wrappedTiles = new WeakSet();
  function attach(group) {
    for (const layer of group.getLayers().getArray()) {
      if (layer.getLayers) { attach(layer); continue; }
      const source = layer.getSource?.();
      if (!source?.getTile || registry.has(source)) continue;
      const state = { id: registry.size, tiles: new Map() };
      registry.set(source, state);
      const descriptor = Object.getOwnPropertyDescriptor(source, 'getTile');
      const original = source.getTile;
      const starts = new WeakMap();
      function remember(tile, args) {
        const coord = args ?? tile?.getTileCoord?.();
        if (coord) state.tiles.set(tileKey(...coord), { ref: tile ? new WeakRef(tile) : null, sourceKey: source.getKey() });
        if (tile?.load && !wrappedTiles.has(tile) && hooks.enter) {
          const ref = new WeakRef(tile), desc = Object.getOwnPropertyDescriptor(tile, 'load'), load = tile.load;
          tile.load = function (...values) {
            const previous = hooks.enter(this, source);
            try { return Reflect.apply(load, this, values); } finally { hooks.leave(previous); }
          };
          wrappedTiles.add(tile);
          cleanup.push(() => { const t = ref.deref(); if (t) { if (desc) Object.defineProperty(t, 'load', desc); else delete t.load; } });
        }
      }
      function wrapper(...args) {
        const tile = Reflect.apply(original, this, args);
        // Instrumentation must never replace the result or turn successful calls into errors.
        try { remember(tile, args); } catch { /* coverage fails closed */ }
        return tile;
      }
      source.getTile = wrapper;
      cleanup.push(() => { if (descriptor) Object.defineProperty(source, 'getTile', descriptor); else delete source.getTile; });
      for (const event of ['tileloadstart', 'tileloadend', 'tileloaderror']) {
        const fn = e => {
          const tile = e?.tile;
          try { remember(tile); } catch { /* no event payload retained */ }
          const matched = !!tile && starts.has(tile);
          const sameStep = matched && starts.get(tile) === stepToken();
          if (tile && event === 'tileloadstart') starts.set(tile, stepToken());
          else if (tile) starts.delete(tile);
          activity(event, { start_observed_during_run: matched, start_observed_during_step: sameStep }, { tile, source });
        };
        source.on(event, fn); cleanup.push(() => source.un(event, fn));
      }
    }
  }
  const restore = () => { for (const fn of cleanup.splice(0).reverse()) { try { fn(); } catch { /* continue restoring remaining sources */ } } registry.clear(); };
  try { attach(map); } catch { restore(); throw Error('Tile instrumentation unavailable.'); }
  return { registry, restore };
}

export function summarize(rows) {
  return [...new Set(rows.map(r => r.label))].map(label => {
    const a = rows.filter(r => r.label === label), valid = a.filter(r => r.terminal_state === 'completed');
    const stats = list => Object.fromEntries(['moveend_ms', 'first_rendercomplete_ms', 'frame_complete_ms', 'technical_settled_ms'].map(k =>
      [k, { n: list.filter(r => Number.isFinite(r[k])).length, p50: percentile(list.map(r => r[k]), .5), p95: percentile(list.map(r => r[k]), .95) }]));
    return { label, total: a.length, valid: valid.length, invalid: a.filter(r => r.validity === 'invalid').length,
      indeterminate: a.filter(r => r.validity === 'indeterminate').length,
      completed: valid.length, failed: a.filter(r => r.terminal_state === 'failed').length,
      cancelled: a.filter(r => r.terminal_state === 'cancelled').length,
      without_new_frame_evidence: a.filter(r => !r.wado_count && !r.frame_started && !r.frame_ended).length,
      percentiles: stats(valid), by_observation: Object.fromEntries(['valid_with_new_wado', 'valid_cached_tiles', 'valid_without_observed_wado']
        .map(k => [k, { n: valid.filter(r => r.observation === k).length, percentiles: stats(valid.filter(r => r.observation === k)) }])) };
  });
}
