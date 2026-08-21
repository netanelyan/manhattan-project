// What is under the cursor.
//
// NO NEW INDEX. A tile *is* a spatial index, and the path from a click to a
// placement is the culling path run backwards: chip point -> block point
// through the instance transform (exact, and exactly invertible), block point
// -> tile through the same arithmetic that decides what to fetch, tile ->
// placement by scanning the tile. A tile holds a few thousand placements, so the
// scan is well under a millisecond, and the alternative - a parallel structure -
// would have to be built per level, kept in step with eviction, and would answer
// nothing the tile does not already know.
//
// Two things make the scan wider than one tile. Placements bleed outside their
// tile by up to the level's content bleed, so a click near an edge can belong to
// a neighbour; and anything oversized for the level lives in the overflow list,
// which is where macros and long straps are. Both are cheap to include.

import {
  I_STRIDE, B_STRIDE, B_DENSITY, B_LAYER, B_FILL, TILE_KIND,
  M_STRIDE, M_W, M_H, M_KLASS, LAYER_CELLBOX, CLASS_LAYER, key, overflowKey,
} from './format.js';

export const KLASS_NAME = ['cell', 'macro', 'power', 'filler'];
export const ORIENT_NAME = ['N', 'S', 'W', 'E', 'FN', 'FS', 'FW', 'FE'];

// A master's box under a LEF orientation: 90-degree rotations swap it, mirrors
// do not. Same rule as the generator and the vertex shader.
function orientedBox(masters, m, o) {
  const w = masters.masters[m * M_STRIDE + M_W], h = masters.masters[m * M_STRIDE + M_H];
  const rot = o === 2 || o === 3 || o === 6 || o === 7;
  return rot ? { w: h, h: w } : { w, h };
}

// Placements of one tile that contain (bx, by), in block coordinates.
function scanPlacements(tile, bx, by, masters, out) {
  const lx = bx - tile.originX, ly = by - tile.originY;
  const inst = tile.inst;
  for (let i = 0; i < tile.count; i++) {
    const p = i * I_STRIDE;
    const x = inst[p], y = inst[p + 1];
    if (lx < x || ly < y) continue;
    const packed = inst[p + 2];
    const m = packed & 0xffff, o = (packed >> 16) & 0xff;
    const b = orientedBox(masters, m, o);
    if (lx >= x + b.w || ly >= y + b.h) continue;
    out.push({
      master: m, orient: o, w: b.w, h: b.h,
      x: tile.originX + x, y: tile.originY + y,
      klass: masters.masters[m * M_STRIDE + M_KLASS],
      index: i, tile,
    });
  }
}

// The density block of a far tile that contains (bx, by).
function scanBlocks(tile, bx, by) {
  const lx = bx - tile.originX, ly = by - tile.originY;
  const bi = tile.blocks, bf = tile.blocksF;
  for (let i = 0; i < tile.count; i++) {
    const p = i * B_STRIDE;
    const x = bi[p], y = bi[p + 1], w = bi[p + 2], h = bi[p + 3];
    if (lx < x || ly < y || lx >= x + w || ly >= y + h) continue;
    if (bi[p + B_LAYER] !== LAYER_CELLBOX) continue;      // macro and power draw on top
    return {
      x: tile.originX + x, y: tile.originY + y, w, h,
      density: bf[p + B_DENSITY], fill: bf[p + B_FILL],
      index: i, tile,
    };
  }
  return null;
}

// What a click can land on, by the panel's S column. A click resolves to a
// placement or to a density block, and what either of those *is* - a cell, a
// macro, the power grid - is an instance category, never a process layer. So
// the selectable mask is read at the category bit, whatever level is on screen:
// unchecking S on macros at a deep level skips the macro placement and the cell
// underneath it answers, which is the whole point of the column.
const selectable = (mask, layer) => ((mask >> layer) & 1) === 1;

// (cx, cy) in chip nanometres. Returns null, a placement hit, or - at a far
// level, where there are no placements to report - the density block, because
// reporting a placement that is not there would be worse than reporting nothing.
//
// When everything under the point was excluded by the selectable mask, the miss
// says so: `{ kind: 'filtered' }` with how many were skipped. A filter that
// turns a hit into silence otherwise looks exactly like a broken viewer.
export function pick(cx, cy, ctx) {
  const { chip, store, level, masters } = ctx;
  const selectMask = ctx.selectMask === undefined ? 0xffff : ctx.selectMask;
  const z = level.z, S = level.tileSize, over = level.maxOverhang || 0;
  const far = level.kind === 'far';
  let filtered = null;

  for (const inst of chip.visible({ minX: cx, minY: cy, maxX: cx, maxY: cy })) {
    const [bx, by] = inst.T.toBlock(cx, cy);
    if (bx < 0 || by < 0) continue;

    const tx = Math.floor(bx / S), ty = Math.floor(by / S);
    if (tx >= level.tilesPerSide || ty >= level.tilesPerSide) continue;

    if (far) {
      const t = store.peek(key(z, tx, ty));
      const hit = t && t.kind === TILE_KIND.FAR ? scanBlocks(t, bx, by) : null;
      if (!hit) continue;
      if (!selectable(selectMask, LAYER_CELLBOX)) {
        filtered = filtered || { kind: 'filtered', count: 0, inst, z, tx, ty };
        filtered.count++;
        continue;
      }
      return { kind: 'block', inst, z, tx, ty, ...hit };
    }

    // The tile the point is in, plus any neighbour whose content can reach it,
    // plus the level's overflow list.
    const found = [];
    const nx0 = Math.max(0, Math.floor((bx - over) / S)), ny0 = Math.max(0, Math.floor((by - over) / S));
    for (let y = ny0; y <= ty; y++) {
      for (let x = nx0; x <= tx; x++) {
        const t = store.peek(key(z, x, y));
        if (t && t.inst) scanPlacements(t, bx, by, masters, found);
      }
    }
    const ovf = store.peek(overflowKey(z));
    if (ovf && ovf.inst) scanPlacements(ovf, bx, by, masters, found);
    if (!found.length) continue;

    const ok = found.filter(f => selectable(selectMask, CLASS_LAYER[f.klass]));
    if (!ok.length) {
      filtered = filtered || { kind: 'filtered', count: 0, inst, z, tx, ty };
      filtered.count += found.length;
      continue;
    }

    // Smallest wins: a cell inside a macro's footprint, or under a power strap,
    // is the more specific answer to "what is this". The S column is the
    // deliberate version of the same decision, and it runs first.
    ok.sort((a, b) => a.w * a.h - b.w * b.h);
    return { kind: 'placement', inst, z, tx, ty, overlaps: ok.length - 1, ...ok[0] };
  }
  return filtered;
}
