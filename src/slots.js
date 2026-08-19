// Slot building: turn one tile into the GPU records for its slots.
//
// A slot is the per-instance record the vertex shader reads. It is deliberately
// origin-independent - tile-local coordinates plus a tile index - so a tile's
// slots are written once when it loads and never rewritten. Panning does not
// touch them; a view-origin resnap does not touch them. Only the small
// per-tile origin table changes, and that is a handful of floats.
//
// That is what replaces the old full-buffer rebuild: a visible-set change costs
// (tiles entering) x (their placements), not (every visible placement).
//
// Pure CPU, no WebGL, so tools/bench.js can measure it outside the browser.

import { I_STRIDE, B_STRIDE, B_SPARE, BK_STRIDE, BK_START, BK_COUNT, BK_ID } from './format.js';

// Placement slot: i32 x, i32 y, i32 packed(master|orient<<16), i32 tileSlot.
// The first three words are the file's placement record verbatim; only the
// stride changes and the tile index is appended.
export const PLACEMENT_SLOT_I32 = 4;

// Block slot: the file's 32-byte block record with its spare word set to the
// tile index. Nothing else changes.
export const BLOCK_SLOT_I32 = 8;

export const FREE_PACKED = -1;   // sentinel in a placement slot's packed word
export const FREE_LAYER  = -1;   // sentinel in a block slot's layer word

// Copy [start, start+count) placements of `tile` into `out` as slots.
export function buildPlacementSlots(tile, start, count, tileSlot, out) {
  const inst = tile.inst;
  let w = 0;
  for (let i = start, end = start + count; i < end; i++) {
    const p = i * I_STRIDE;
    out[w] = inst[p];
    out[w + 1] = inst[p + 1];
    out[w + 2] = inst[p + 2];
    out[w + 3] = tileSlot;
    w += PLACEMENT_SLOT_I32;
  }
  return count;
}

// Copy a far tile's blocks into `out` as slots.
export function buildBlockSlots(tile, tileSlot, out) {
  const b = tile.blocks;
  const n = tile.count * B_STRIDE;
  out.set(b.subarray(0, n));
  for (let i = 0; i < tile.count; i++) out[i * B_STRIDE + B_SPARE] = tileSlot;
  return tile.count;
}

// Fill `out` with free-slot sentinels so a released range draws nothing.
export function fillFreePlacements(out, count) {
  for (let i = 0; i < count; i++) {
    const w = i * PLACEMENT_SLOT_I32;
    out[w] = 0; out[w + 1] = 0; out[w + 2] = FREE_PACKED; out[w + 3] = 0;
  }
}

export function fillFreeBlocks(out, count) {
  out.fill(0, 0, count * BLOCK_SLOT_I32);
  for (let i = 0; i < count; i++) out[i * BLOCK_SLOT_I32 + 5] = FREE_LAYER;
}

// A deep tile's placements are already sorted by bucket, so each bucket is one
// contiguous slice. Returns [{bucket, start, count}] for the tile.
export function tileBuckets(tile) {
  const out = [];
  for (let g = 0; g < tile.bucketCount; g++) {
    const b = g * BK_STRIDE;
    out.push({
      bucket: tile.buckets[b + BK_ID],
      start: tile.buckets[b + BK_START],
      count: tile.buckets[b + BK_COUNT],
    });
  }
  return out;
}
