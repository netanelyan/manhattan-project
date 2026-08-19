'use strict';
// Binary layout constants, shared by the generator and documented in
// docs/tile-format.md. Everything is little-endian and 4-byte aligned so the
// viewer can take typed-array views straight over the ArrayBuffer.

// "MTNM" and "MTNT" in file byte order, read back as little-endian uint32.
const MAGIC_MASTERS = 0x4d4e544d;
const MAGIC_TILE    = 0x544e544d;
const VERSION       = 3;

// masters.bin
const M_HEADER_BYTES = 32;
const MASTER_BYTES   = 32;   // 8 x i32, consumed as 2 RGBA32I texels
const RECT_BYTES     = 32;   // 8 x i32, consumed as 2 RGBA32I texels

// tiles/{z}/{x}/{y}.bin
const T_HEADER_BYTES = 64;
const BUCKET_BYTES   = 16;   // 4 x u32      deep only: rect-count bucket table
const INSTANCE_BYTES = 12;   // 3 x i32      deep and mid share one placement record
const BLOCK_BYTES    = 32;   // 8 x i32/f32  far: merged density block

// The three LOD representations. A tile is exactly one of them.
const TILE_KIND = { DEEP: 0, FAR: 1, MID: 2 };
const KIND_NAME = { 0: 'deep', 1: 'far', 2: 'mid' };
const RECORD_BYTES = { 0: INSTANCE_BYTES, 1: BLOCK_BYTES, 2: INSTANCE_BYTES };

// Master geometry and the master table are both uploaded as RGBA32I textures of
// this fixed width, so the viewer addresses record r at texel 2r with a shift
// and a mask.
const RECT_TEX_WIDTH = 1024;

// --- Rect-count buckets.
//
// Draw calls are grouped by how many rectangles a master has, not by which
// master it is. Every instance carries its master id and the vertex shader
// looks the geometry up, so one draw call covers every master in the bucket.
// That makes the draw count a function of bucket count - a constant - instead
// of library size. A draw issues 6 * cap vertices per instance, so masters
// below their bucket cap pay for surplus degenerate triangles.
//
// The caps are DERIVED from the design's actual rect-count histogram, not
// fixed, because the right cut depends entirely on where the library spikes.
// A synthetic fit would be a fit to invented data. The fallback below is only
// used if derivation cannot run.
const BUCKET_CAPS_FALLBACK = [8, 16, 32, 64];
const DEFAULT_BUCKETS = 8;

// Optimal caps for a placement-weighted rect-count histogram, by dynamic
// programming. Partitioning a sorted list into K contiguous groups where a
// group costs (its weight) x (its largest member) is exactly the 1-D weighted
// quantisation problem, and it is small enough - at most a few dozen distinct
// rect counts - to solve exactly rather than heuristically.
//
//   hist: Map of rectCount -> weight (placement frequency, any scale)
//   K:    number of buckets wanted
//
// Returns ascending caps; the last is always the library maximum.
function deriveCaps(hist, K = DEFAULT_BUCKETS) {
  const r = [...hist.keys()].filter(k => k > 0).sort((a, b) => a - b);
  const m = r.length;
  if (m === 0) return BUCKET_CAPS_FALLBACK.slice();
  if (m <= K) return r;                       // one bucket each: zero waste

  const w = r.map(k => hist.get(k));
  const W = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) W[i + 1] = W[i] + w[i];

  const INF = Infinity;
  let prev = new Float64Array(m + 1).fill(INF);
  const back = [];
  for (let i = 1; i <= m; i++) prev[i] = W[i] * r[i - 1];      // k = 1
  back.push(new Int32Array(m + 1));

  for (let k = 2; k <= K; k++) {
    const cur = new Float64Array(m + 1).fill(INF);
    const bk = new Int32Array(m + 1);
    for (let i = k; i <= m; i++) {
      const cap = r[i - 1];
      for (let j = k - 1; j < i; j++) {
        if (prev[j] === INF) continue;
        const c = prev[j] + (W[i] - W[j]) * cap;
        if (c < cur[i]) { cur[i] = c; bk[i] = j; }
      }
    }
    prev = cur;
    back.push(bk);
  }

  const caps = [];
  let i = m;
  for (let k = K; k >= 1 && i > 0; k--) {
    caps.push(r[i - 1]);
    i = k === 1 ? 0 : back[k - 1][i];
  }
  return caps.reverse();
}

// Total rectangles submitted for a histogram under a given cap list, and the
// fraction of that which is padding.
function capCost(hist, caps) {
  let actual = 0, submitted = 0;
  for (const [rc, w] of hist) {
    if (rc <= 0) continue;
    actual += w * rc;
    submitted += w * (caps.find(c => rc <= c) ?? caps[caps.length - 1]);
  }
  return { actual, submitted, waste: submitted ? 1 - actual / submitted : 0 };
}

function bucketOf(rectCount, caps) {
  for (let i = 0; i < caps.length; i++) if (rectCount <= caps[i]) return i;
  return caps.length - 1;
}

// Abstract layers, used by mid and far tiles. Ordered so the depth key
// (layer id) paints cells, then macros, then the power grid.
const ABSTRACT_LAYER = { CELLBOX: 12, MACROBOX: 13, POWERBOX: 14 };

// Block sub-kinds inside a far tile.
const BLOCK_KIND = { DENSITY: 0, MACRO: 1, POWER: 2 };

// --- Overflow.
//
// A placement wider or taller than this fraction of its level's tile is not
// stored in a tile at all - it would inflate that tile's content box and force
// the viewer to fetch a huge ring of neighbours. It goes to the level's
// overflow list instead: one small file per level, always loaded with the
// level, holding the handful of features that are oversized at this zoom.
const OVERSIZE_FRAC = 0.25;
const OVERFLOW_XY = 0xffffffff;   // tx/ty sentinel in an overflow tile header

// --- LOD planning constants. The generator uses these to decide which
// representation each pyramid level carries; the viewer re-derives the same
// numbers from tile headers at runtime.
const RECT_BUDGET  = 2000000;  // rectangles on screen at 60fps (docs/renderer-findings.md)
const VIS_TILES    = 32;       // tiles a 3440x1440 viewport covers at TILE_PX
const TILE_PX      = 512;      // nominal on-screen size of one tile
const MIN_CELL_PX  = 1.5;      // below this an outline is subpixel mud -> go far
const MAX_DEEP     = 2;        // internals only matter at the deepest levels
const BLOCK_GRID   = 32;       // density blocks per side, per far tile

// --- Runtime level choice.
//
// The generator picks a representation per level; the viewer has to pick which
// level to draw at the camera's current zoom. It decides on the same two
// numbers - the rectangle budget and how many pixels a cell covers - so what
// is on screen is what the level was built for.
//
// These are the extra inputs that only matter at runtime.
const REF_VIEW       = { w: 3440, h: 1440 };  // viewport the shipped ladder is quoted at
const MAX_VIS_TILES  = 128;    // fetch rail: tiles one visible set may hold (4x VIS_TILES)
const LOD_HYSTERESIS = 1.3;    // switch-in scale is this much above the switch-out scale

// The ladder itself - what these feed - is src/lod.js, imported by the
// generator rather than reimplemented here. It is the one piece of arithmetic
// the generator and the viewer must agree on exactly, and two copies of it
// would be two chances to disagree.

module.exports = {
  MAGIC_MASTERS, MAGIC_TILE, VERSION,
  M_HEADER_BYTES, MASTER_BYTES, RECT_BYTES,
  T_HEADER_BYTES, BUCKET_BYTES, INSTANCE_BYTES, BLOCK_BYTES,
  TILE_KIND, KIND_NAME, RECORD_BYTES, RECT_TEX_WIDTH,
  BUCKET_CAPS_FALLBACK, DEFAULT_BUCKETS, deriveCaps, capCost, bucketOf,
  ABSTRACT_LAYER, BLOCK_KIND,
  OVERSIZE_FRAC, OVERFLOW_XY,
  RECT_BUDGET, VIS_TILES, TILE_PX, MIN_CELL_PX, MAX_DEEP, BLOCK_GRID,
  REF_VIEW, MAX_VIS_TILES, LOD_HYSTERESIS,
};
