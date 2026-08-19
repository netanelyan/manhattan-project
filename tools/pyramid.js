'use strict';
// Quadtree pyramid construction: level planning, bucketing, overflow promotion,
// and building each of the three LOD representations. Emits Buffers; gen.js
// does the I/O.

const F = require('./format.js');
const { K, O } = require('./layout.js');

// Bounding box of a master under a LEF orientation. 90-degree rotations swap
// the box; mirrors do not.
function orientedBox(masters, m, orient) {
  const rot = orient === O.W || orient === O.E || orient === O.FW || orient === O.FE;
  return rot ? { w: masters[m].h, h: masters[m].w }
             : { w: masters[m].w, h: masters[m].h };
}

// ---------------------------------------------------------------- bucketing
// Every instance lands in exactly one deepest-level tile, keyed by its origin
// corner. Coarser levels are built by gathering the 4^(maxZ-z) deepest buckets
// they cover, so bucketing happens once for the whole pyramid.
function bucketDeepest(gen, tilesPerSide, tileSize) {
  const { x, y, n } = gen.instances;
  const nTiles = tilesPerSide * tilesPerSide;
  const counts = new Int32Array(nTiles + 1);
  const tileOf = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    let tx = (x[i] / tileSize) | 0;
    let ty = (y[i] / tileSize) | 0;
    if (tx < 0) tx = 0; else if (tx >= tilesPerSide) tx = tilesPerSide - 1;
    if (ty < 0) ty = 0; else if (ty >= tilesPerSide) ty = tilesPerSide - 1;
    const t = ty * tilesPerSide + tx;
    tileOf[i] = t;
    counts[t + 1]++;
  }
  for (let t = 0; t < nTiles; t++) counts[t + 1] += counts[t];

  const start = counts.slice(0, nTiles);
  const cursor = counts.slice(0, nTiles);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[cursor[tileOf[i]]++] = i;

  return { start, end: counts.subarray(1), order, nTiles, tilesPerSide, tileSize };
}

// Instance indices belonging to level-z tile (X, Y), skipping any master that
// is oversized at this level - those live in the level's overflow list.
function collectTile(bucket, maxZ, z, X, Y, out, oversize, im) {
  const S = 1 << (maxZ - z);
  const side = bucket.tilesPerSide;
  let n = 0;
  for (let ty = Y * S, tyEnd = (Y + 1) * S; ty < tyEnd; ty++) {
    const row = ty * side;
    for (let tx = X * S, txEnd = (X + 1) * S; tx < txEnd; tx++) {
      const t = row + tx;
      for (let i = bucket.start[t], e = bucket.end[t]; i < e; i++) {
        const j = bucket.order[i];
        if (oversize[im[j]]) continue;
        out[n++] = j;
      }
    }
  }
  return n;
}

// Instance count per tile at level z, without gathering anything.
function levelCounts(bucket, maxZ, z) {
  const side = 1 << z;
  const S = 1 << (maxZ - z);
  const out = new Int32Array(side * side);
  for (let Y = 0; Y < side; Y++) {
    for (let X = 0; X < side; X++) {
      let c = 0;
      for (let ty = Y * S, tyEnd = (Y + 1) * S; ty < tyEnd; ty++) {
        const row = ty * bucket.tilesPerSide;
        for (let tx = X * S, txEnd = (X + 1) * S; tx < txEnd; tx++) {
          c += bucket.end[row + tx] - bucket.start[row + tx];
        }
      }
      out[Y * side + X] = c;
    }
  }
  return out;
}

// ---------------------------------------------------------------- planning
// Which representation does each level carry?
//
//   deep  full master internals, ~meanRects rectangles per placement
//   mid   one rectangle per placement, the cell outline only
//   far   merged density blocks, not instances at all
//
// A level is deep only if it is one of the deepest MAX_DEEP levels *and* its
// rectangle cost fits the budget. It is mid while one rect per placement still
// fits the budget and a placement is still wider than MIN_CELL_PX on screen -
// below that an outline is subpixel and blocks carry more information. The
// assignment is forced monotone: internals never reappear above an abstract
// level.
function planLevels(bucket, maxZ, tileSize, worldSize, meanRects, meanCellW) {
  const levels = [];
  let floor = F.TILE_KIND.DEEP;

  for (let z = maxZ; z >= 0; z--) {
    const counts = levelCounts(bucket, maxZ, z);
    const nonEmpty = Array.from(counts).filter(c => c > 0).sort((a, b) => a - b);
    const p95 = nonEmpty.length ? nonEmpty[Math.min(nonEmpty.length - 1, Math.floor(nonEmpty.length * 0.95))] : 0;
    const size = tileSize * (1 << (maxZ - z));
    const visT = Math.min((1 << z) * (1 << z), F.VIS_TILES);
    const cellPx = meanCellW * F.TILE_PX / size;
    const deepCost = visT * p95 * meanRects;
    const midCost = visT * p95;

    let kind;
    if (maxZ - z < F.MAX_DEEP && deepCost <= F.RECT_BUDGET) kind = F.TILE_KIND.DEEP;
    else if (midCost <= F.RECT_BUDGET && cellPx >= F.MIN_CELL_PX) kind = F.TILE_KIND.MID;
    else kind = F.TILE_KIND.FAR;

    if (kind === F.TILE_KIND.DEEP && floor !== F.TILE_KIND.DEEP) kind = floor;
    if (kind === F.TILE_KIND.MID && floor === F.TILE_KIND.FAR) kind = F.TILE_KIND.FAR;
    floor = kind;

    levels.unshift({
      z, kind, tilesPerSide: 1 << z, tileSize: size, counts,
      p95, visT, cellPx, nonEmpty: nonEmpty.length,
      cost: kind === F.TILE_KIND.DEEP ? deepCost : kind === F.TILE_KIND.MID ? midCost : null,
    });
  }
  return levels;
}

// ---------------------------------------------------------------- overflow
// Which masters are too large to sit in a tile at this level. A placement wider
// or taller than OVERSIZE_FRAC of the tile would blow up that tile's content
// box, and since culling has to expand by the level's worst content box, one
// macro forces the viewer to fetch a huge ring of neighbours. Promote them out.
function oversizeMask(masters, tileSize) {
  const mask = new Uint8Array(masters.length);
  const limit = F.OVERSIZE_FRAC * tileSize;
  for (let m = 0; m < masters.length; m++) {
    mask[m] = Math.max(masters[m].w, masters[m].h) > limit ? 1 : 0;
  }
  return mask;
}

function collectOverflow(gen, mask) {
  const { m, n } = gen.instances;
  const idx = [];
  for (let i = 0; i < n; i++) if (mask[m[i]]) idx.push(i);
  return Int32Array.from(idx);
}

// ---------------------------------------------------------------- header
function writeHeader(buf, { kind, z, bucketCount, count, originX, originY, tileSize,
                            rectCount, minX, minY, maxX, maxY, bucketsOff, dataOff, tx, ty }) {
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, 16);
  const i32 = new Int32Array(buf.buffer, buf.byteOffset, 16);
  u32[0] = F.MAGIC_TILE;
  buf.writeUInt16LE(F.VERSION, 4);
  buf.writeUInt16LE(kind, 6);
  buf.writeUInt8(z, 8);
  buf.writeUInt8(0, 9);
  buf.writeUInt16LE(bucketCount, 10);
  u32[3] = count;
  i32[4] = originX; i32[5] = originY; i32[6] = tileSize;
  u32[7] = rectCount;
  i32[8] = minX; i32[9] = minY; i32[10] = maxX; i32[11] = maxY;
  u32[12] = bucketsOff; u32[13] = dataOff;
  u32[14] = tx; u32[15] = ty;
}

// Shared writer for the placement record array used by deep and mid tiles.
// Returns the content bounding box.
function writePlacements(i32, p0, gen, order, n, originX, originY) {
  const { x, y, m, o } = gen.instances;
  let minX = 0x7fffffff, minY = 0x7fffffff, maxX = -0x80000000, maxY = -0x80000000;
  let p = p0;
  for (let i = 0; i < n; i++) {
    const j = order[i];
    const lx = x[j] - originX, ly = y[j] - originY;
    const box = orientedBox(gen.masters, m[j], o[j]);
    if (lx < minX) minX = lx;
    if (ly < minY) minY = ly;
    if (lx + box.w > maxX) maxX = lx + box.w;
    if (ly + box.h > maxY) maxY = ly + box.h;
    i32[p] = lx; i32[p + 1] = ly;
    i32[p + 2] = (m[j] & 0xffff) | ((o[j] & 0xff) << 16);
    p += 3;
  }
  if (n === 0) { minX = minY = maxX = maxY = 0; }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------- deep tiles
// Placements sorted by rect-count bucket, with a bucket table. The viewer draws
// one call per bucket over every visible tile at once, so the draw count is set
// by bucket granularity (a constant) rather than by library size.
function buildDeepTile(gen, idx, n, z, tx, ty, tileSize, scratch, caps) {
  const { m } = gen.instances;
  const masters = gen.masters;
  const nB = caps.length;

  const cnt = scratch.cnt;
  cnt.fill(0, 0, nB + 1);
  for (let i = 0; i < n; i++) cnt[F.bucketOf(masters[m[idx[i]]].rectCount, caps) + 1]++;

  const buckets = [];
  for (let b = 0; b < nB; b++) {
    if (cnt[b + 1] > 0) buckets.push({ bucket: b, start: cnt[b], count: cnt[b + 1], rects: 0 });
    cnt[b + 1] += cnt[b];
  }
  const cursor = scratch.cursor;
  cursor.set(cnt.subarray(0, nB));
  const sorted = scratch.sorted;
  let rectTotal = 0;
  for (let i = 0; i < n; i++) {
    const j = idx[i];
    const rc = masters[m[j]].rectCount;
    rectTotal += rc;
    sorted[cursor[F.bucketOf(rc, caps)]++] = j;
  }
  // per-bucket actual rect totals, for budgeting
  for (const g of buckets) {
    let r = 0;
    for (let i = g.start; i < g.start + g.count; i++) r += masters[m[sorted[i]]].rectCount;
    g.rects = r;
  }

  const bucketsOff = F.T_HEADER_BYTES;
  const dataOff = bucketsOff + buckets.length * F.BUCKET_BYTES;
  const buf = Buffer.alloc(dataOff + n * F.INSTANCE_BYTES);
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  const i32 = new Int32Array(buf.buffer, buf.byteOffset, buf.length >> 2);

  const originX = tx * tileSize, originY = ty * tileSize;
  const bb = writePlacements(i32, dataOff >> 2, gen, sorted, n, originX, originY);

  writeHeader(buf, {
    kind: F.TILE_KIND.DEEP, z, bucketCount: buckets.length, count: n,
    originX, originY, tileSize, rectCount: rectTotal,
    minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY,
    bucketsOff, dataOff, tx, ty,
  });
  let g = bucketsOff >> 2;
  for (const b of buckets) {
    u32[g] = b.bucket; u32[g + 1] = b.start; u32[g + 2] = b.count; u32[g + 3] = b.rects;
    g += 4;
  }
  return { buf, rectCount: rectTotal, bucketCount: buckets.length, count: n };
}

// ---------------------------------------------------------------- mid tiles
// One rectangle per placement: the cell outline, nothing inside it. The record
// is byte-identical to a deep tile's placement record - the difference is that
// a mid tile has no bucket table and the viewer draws each placement as its
// master's bounding box, never touching the rect table. Outline w/h comes from
// the master table, which is resident from boot.
function buildMidTile(gen, idx, n, z, tx, ty, tileSize) {
  const dataOff = F.T_HEADER_BYTES;
  const buf = Buffer.alloc(dataOff + n * F.INSTANCE_BYTES);
  const i32 = new Int32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  const originX = tx * tileSize, originY = ty * tileSize;
  const bb = writePlacements(i32, dataOff >> 2, gen, idx, n, originX, originY);

  writeHeader(buf, {
    kind: F.TILE_KIND.MID, z, bucketCount: 0, count: n,
    originX, originY, tileSize, rectCount: n,
    minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY,
    bucketsOff: dataOff, dataOff, tx, ty,
  });
  return { buf, rectCount: n, bucketCount: 0, count: n };
}

// An overflow list is a whole-world tile: same representation as its level,
// origin at 0, spanning the world. It holds only the features that are
// oversized at this level, so it stays small and is loaded once per level.
function buildOverflowTile(gen, idx, z, kind, worldSize, scratch, caps) {
  const n = idx.length;
  const out = kind === F.TILE_KIND.DEEP
    ? buildDeepTile(gen, idx, n, z, 0, 0, worldSize, scratch, caps)
    : buildMidTile(gen, idx, n, z, 0, 0, worldSize);
  const u32 = new Uint32Array(out.buf.buffer, out.buf.byteOffset, 16);
  u32[14] = F.OVERFLOW_XY;
  u32[15] = F.OVERFLOW_XY;
  return out;
}

// ---------------------------------------------------------------- far tiles
// A density mip chain over standard cell area, plus macros and merged power
// straps kept as sharp objects. Averaging every placement into one grey field
// is exactly the mud the spike found; keeping the structure that carries
// meaning - macro blocks, the power grid, the density gradient between regions
// - is what makes a full-die view readable.
function buildDensityMips(gen, worldSize, zFarMax) {
  const { x, y, m, n } = gen.instances;
  const masters = gen.masters;
  const R = F.BLOCK_GRID << zFarMax;
  const base = new Float64Array(R * R);
  const cell = worldSize / R;

  for (let i = 0; i < n; i++) {
    const ms = masters[m[i]];
    if (ms.klass !== K.STD) continue;
    let gi = ((x[i] + ms.w * 0.5) / cell) | 0;
    let gj = ((y[i] + ms.h * 0.5) / cell) | 0;
    if (gi < 0) gi = 0; else if (gi >= R) gi = R - 1;
    if (gj < 0) gj = 0; else if (gj >= R) gj = R - 1;
    base[gj * R + gi] += ms.w * ms.h;
  }
  const cellArea = cell * cell;
  for (let i = 0; i < base.length; i++) base[i] = Math.min(1, base[i] / cellArea);

  const mips = [];
  mips[zFarMax] = base;
  for (let z = zFarMax - 1; z >= 0; z--) {
    const sHi = F.BLOCK_GRID << (z + 1), sLo = F.BLOCK_GRID << z;
    const hi = mips[z + 1], lo = new Float64Array(sLo * sLo);
    for (let j = 0; j < sLo; j++)
      for (let i = 0; i < sLo; i++)
        lo[j * sLo + i] = 0.25 * (hi[(2 * j) * sHi + 2 * i] + hi[(2 * j) * sHi + 2 * i + 1] +
                                  hi[(2 * j + 1) * sHi + 2 * i] + hi[(2 * j + 1) * sHi + 2 * i + 1]);
    mips[z] = lo;
  }
  return mips;
}

function collectStructures(gen) {
  const { x, y, m, o, n } = gen.instances;
  const masters = gen.masters;
  const macros = [];
  const vRuns = new Map(), hRuns = new Map();

  for (let i = 0; i < n; i++) {
    const ms = masters[m[i]];
    if (ms.klass === K.MACRO) {
      const box = orientedBox(masters, m[i], o[i]);
      macros.push({ x: x[i], y: y[i], w: box.w, h: box.h });
    } else if (ms.klass === K.PWR) {
      const vertical = ms.w < ms.h;
      const map = vertical ? vRuns : hRuns;
      const key = vertical ? `${x[i]},${ms.w}` : `${y[i]},${ms.h}`;
      let a = map.get(key);
      if (!a) { a = []; map.set(key, a); }
      a.push(vertical ? [y[i], y[i] + ms.h] : [x[i], x[i] + ms.w]);
    }
  }

  const straps = [];
  const coalesce = (map, vertical) => {
    for (const [key, spans] of map) {
      const [pos, thick] = key.split(',').map(Number);
      spans.sort((a, b) => a[0] - b[0]);
      let s = spans[0][0], e = spans[0][1];
      for (let i = 1; i < spans.length; i++) {
        if (spans[i][0] <= e) { e = Math.max(e, spans[i][1]); continue; }
        straps.push(vertical ? { x: pos, y: s, w: thick, h: e - s } : { x: s, y: pos, w: e - s, h: thick });
        s = spans[i][0]; e = spans[i][1];
      }
      straps.push(vertical ? { x: pos, y: s, w: thick, h: e - s } : { x: s, y: pos, w: e - s, h: thick });
    }
  };
  coalesce(vRuns, true);
  coalesce(hRuns, false);
  return { macros, straps };
}

// The blocks one far tile holds, before any packing. Split out so the level
// costing pass can count them without allocating a tile.
function farTileBlocks(mips, structures, z, tx, ty, tileSize, worldSize) {
  const grid = F.BLOCK_GRID;
  const side = grid << z;
  const mip = mips[z];
  const originX = tx * tileSize, originY = ty * tileSize;
  const blocks = [];

  const edge = i => Math.round(i * worldSize / side);
  for (let bj = 0; bj < grid; bj++) {
    const gj = ty * grid + bj;
    for (let bi = 0; bi < grid; bi++) {
      const gi = tx * grid + bi;
      const d = mip[gj * side + gi];
      if (d < 0.004) continue;
      const x0 = edge(gi), x1 = edge(gi + 1), y0 = edge(gj), y1 = edge(gj + 1);
      blocks.push([x0 - originX, y0 - originY, x1 - x0, y1 - y0, d,
                   F.ABSTRACT_LAYER.CELLBOX, F.BLOCK_KIND.DENSITY]);
    }
  }

  const clip = (r, layer, kind) => {
    const x0 = Math.max(r.x, originX), y0 = Math.max(r.y, originY);
    const x1 = Math.min(r.x + r.w, originX + tileSize), y1 = Math.min(r.y + r.h, originY + tileSize);
    if (x1 <= x0 || y1 <= y0) return;
    blocks.push([x0 - originX, y0 - originY, x1 - x0, y1 - y0, 1, layer, kind]);
  };
  for (const r of structures.macros) clip(r, F.ABSTRACT_LAYER.MACROBOX, F.BLOCK_KIND.MACRO);
  for (const r of structures.straps) clip(r, F.ABSTRACT_LAYER.POWERBOX, F.BLOCK_KIND.POWER);
  return blocks;
}

function buildFarTile(mips, structures, z, tx, ty, tileSize, worldSize) {
  const blocks = farTileBlocks(mips, structures, z, tx, ty, tileSize, worldSize);
  const originX = tx * tileSize, originY = ty * tileSize;

  const n = blocks.length;
  const dataOff = F.T_HEADER_BYTES;
  const buf = Buffer.alloc(dataOff + n * F.BLOCK_BYTES);
  const i32 = new Int32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.length >> 2);

  let minX = 0x7fffffff, minY = 0x7fffffff, maxX = -0x80000000, maxY = -0x80000000;
  let p = dataOff >> 2;
  for (const b of blocks) {
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[0] + b[2] > maxX) maxX = b[0] + b[2];
    if (b[1] + b[3] > maxY) maxY = b[1] + b[3];
    i32[p] = b[0]; i32[p + 1] = b[1]; i32[p + 2] = b[2]; i32[p + 3] = b[3];
    f32[p + 4] = b[4];
    i32[p + 5] = b[5]; i32[p + 6] = b[6]; i32[p + 7] = 0;
    p += 8;
  }
  if (n === 0) { minX = minY = maxX = maxY = 0; }

  writeHeader(buf, {
    kind: F.TILE_KIND.FAR, z, bucketCount: 0, count: n,
    originX, originY, tileSize, rectCount: n,
    minX, minY, maxX, maxY, bucketsOff: dataOff, dataOff, tx, ty,
  });
  return { buf, rectCount: n, bucketCount: 0, count: n };
}

// ---------------------------------------------------------------- costing
// What a level costs to draw, per tile, computed from the placement list rather
// than from tiles on disk. The LOD ladder has to be solved before anything is
// written, because a level no zoom can ever select is not worth the disk - and
// at a chip's scale that is not a rounding error.
//
// Exact, not an estimate: this counts what buildDeepTile / buildMidTile /
// buildFarTile would put in each tile, promotion to the overflow list included.
function levelRectCounts(gen, bucket, maxZ, L, oversize, mips, structures, worldSize) {
  const side = 1 << L.z;
  const out = new Int32Array(side * side);

  if (L.kind === F.TILE_KIND.FAR) {
    for (let Y = 0; Y < side; Y++)
      for (let X = 0; X < side; X++)
        out[Y * side + X] = farTileBlocks(mips, structures, L.z, X, Y, L.tileSize, worldSize).length;
    return out;
  }

  const deep = L.kind === F.TILE_KIND.DEEP;
  const { m } = gen.instances;
  const masters = gen.masters;
  const shift = maxZ - L.z;
  for (let t = 0; t < bucket.nTiles; t++) {
    const tx = t % bucket.tilesPerSide, ty = (t / bucket.tilesPerSide) | 0;
    const idx = (ty >> shift) * side + (tx >> shift);
    let r = 0;
    for (let i = bucket.start[t], e = bucket.end[t]; i < e; i++) {
      const mm = m[bucket.order[i]];
      if (oversize[mm]) continue;
      r += deep ? masters[mm].rectCount : 1;
    }
    out[idx] += r;
  }
  return out;
}

// The level's overflow list, costed the same way. It is resident whenever the
// level is, so it is part of what the level costs on screen.
function overflowCost(gen, mask, kind) {
  const { m, n } = gen.instances;
  const deep = kind === F.TILE_KIND.DEEP;
  let count = 0, rects = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[m[i]]) continue;
    count++;
    rects += deep ? gen.masters[m[i]].rectCount : 1;
  }
  return { count, rects };
}

// 95th percentile over non-empty tiles, the same statistic the kind assignment
// uses for placement counts.
function p95NonEmpty(counts) {
  const v = Array.from(counts).filter(c => c > 0).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : 0;
}

// ---------------------------------------------------------------- coverage
// Which tiles exist at a level, as a row-major bitmap (LSB first within each
// byte). Cheaper than listing 16k coordinates in the manifest, and it lets the
// viewer skip requests for empty tiles instead of eating 404s.
function coverageBitmap(present, side) {
  const bytes = new Uint8Array(Math.ceil(side * side / 8));
  for (let i = 0; i < side * side; i++) if (present[i]) bytes[i >> 3] |= 1 << (i & 7);
  return bytes;
}

module.exports = {
  bucketDeepest, collectTile, levelCounts, planLevels,
  oversizeMask, collectOverflow,
  buildDeepTile, buildMidTile, buildFarTile, farTileBlocks, buildOverflowTile,
  levelRectCounts, overflowCost, p95NonEmpty,
  buildDensityMips, collectStructures, coverageBitmap, orientedBox,
};
