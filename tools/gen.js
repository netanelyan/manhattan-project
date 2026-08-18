#!/usr/bin/env node
'use strict';
// Manhattan tile generator.
//
//   node tools/gen.js [--count N] [--out DIR] [--seed S] [--per-tile N] [--one-tile]
//
// Writes masters.bin, tiles/{z}/{x}/{y}.bin and manifest.json. Byte layouts are
// documented in docs/tile-format.md. No dependencies beyond core Node.

const fs = require('fs');
const path = require('path');
const layout = require('./layout.js');
const F = require('./format.js');

// ---------------------------------------------------------------- cli
function parseArgs(argv) {
  const o = {
    count: 1000000,
    out: 'data',
    seed: 42,
    perTile: 4096,
    densityLo: 0.40,
    densityHi: 0.95,
    oneTile: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(1); }
      return v;
    };
    switch (a) {
      case '--count':     o.count = parseCount(next()); break;
      case '--out':       o.out = next(); break;
      case '--seed':      o.seed = +next(); break;
      case '--per-tile':  o.perTile = +next(); break;
      case '--density':   { const v = next().split(':'); o.densityLo = +v[0]; o.densityHi = +v[1]; break; }
      case '--one-tile':  o.oneTile = true; break;
      case '-h': case '--help': usage(); process.exit(0);
      default: console.error(`unknown flag ${a}`); usage(); process.exit(1);
    }
  }
  if (!(o.count >= 100000 && o.count <= 50000000)) {
    console.error('--count must be between 100k and 50M');
    process.exit(1);
  }
  return o;
}

function parseCount(s) {
  const m = /^([0-9.]+)([kKmM]?)$/.exec(s.trim());
  if (!m) return NaN;
  const mult = m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1;
  return Math.round(+m[1] * mult);
}

function usage() {
  console.log(`manhattan tile generator

  --count N       total instances, 100k .. 50M (accepts 1.5M / 500k)  [1M]
  --out DIR       output directory                                    [data]
  --seed S        PRNG seed                                           [42]
  --per-tile N    target instances per deepest-level tile             [4096]
  --density LO:HI standard cell row density range                     [0.40:0.95]
  --one-tile      emit only the busiest deepest-level tile (step 1)`);
}

// ---------------------------------------------------------------- helpers
function fmt(n) { return n.toLocaleString('en-US'); }
function um(nm) { return (nm / 1000).toFixed(1) + 'um'; }

// Bounding box of a master under a LEF orientation. 90-degree rotations swap
// the box; mirrors do not.
function orientedBox(m, orient) {
  return (orient === layout.O.W || orient === layout.O.E ||
          orient === layout.O.FW || orient === layout.O.FE)
    ? { w: m.h, h: m.w } : { w: m.w, h: m.h };
}

// ---------------------------------------------------------------- masters.bin
function writeMasters(dir, gen) {
  const nM = gen.masters.length;
  const nR = gen.rects.length / 8;
  const mastersOff = F.M_HEADER_BYTES;
  const rectsOff = mastersOff + nM * F.MASTER_BYTES;
  const total = rectsOff + nR * F.RECT_BYTES;

  const buf = Buffer.alloc(total);
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, total >> 2);
  const i32 = new Int32Array(buf.buffer, buf.byteOffset, total >> 2);

  u32[0] = F.MAGIC_MASTERS;
  buf.writeUInt16LE(F.VERSION, 4);
  buf.writeUInt16LE(0, 6);
  u32[2] = nM;
  u32[3] = nR;
  u32[4] = mastersOff;
  u32[5] = rectsOff;
  u32[6] = layout.DBU_PER_MICRON;
  u32[7] = layout.ROW_H;

  let p = mastersOff >> 2;
  for (const m of gen.masters) {
    i32[p    ] = m.rectStart;
    i32[p + 1] = m.rectCount;
    i32[p + 2] = m.w;
    i32[p + 3] = m.h;
    i32[p + 4] = m.klass;
    i32[p + 5] = m.rowH;
    i32[p + 6] = 0;
    i32[p + 7] = 0;
    p += 8;
  }
  i32.set(gen.rects, rectsOff >> 2);

  fs.writeFileSync(path.join(dir, 'masters.bin'), buf);
  return { bytes: total, masterCount: nM, rectCount: nR };
}

// ---------------------------------------------------------------- tiling
// Bucket every instance into a deepest-level tile by its origin corner, then
// sort each tile's instances by master id so the viewer can draw one call per
// master. Counting sorts throughout: O(n), no comparator, no allocation churn.
function bucketDeepest(gen, tilesPerSide, tileSize) {
  const { x, y, m, o, n } = gen.instances;
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

  const start = counts.slice(0, nTiles);   // copy: cursor advances destructively
  const cursor = counts.slice(0, nTiles);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[cursor[tileOf[i]]++] = i;

  return { start, end: counts.subarray(1), order, nTiles };
}

// Sort one tile's index slice by master id (counting sort over ~400 buckets)
// and emit the group table alongside.
function groupByMaster(gen, order, lo, hi, nMasters, scratch) {
  const { m } = gen.instances;
  const cnt = scratch.cnt;
  cnt.fill(0, 0, nMasters + 1);
  for (let i = lo; i < hi; i++) cnt[m[order[i]] + 1]++;

  const groups = [];
  let rectTotal = 0;
  for (let k = 0; k < nMasters; k++) {
    const c = cnt[k + 1];
    if (c > 0) {
      groups.push({ master: k, start: cnt[k], count: c, rects: c * gen.masters[k].rectCount });
      rectTotal += c * gen.masters[k].rectCount;
    }
    cnt[k + 1] += cnt[k];
  }
  const sorted = scratch.sorted.subarray(0, hi - lo);
  const cursor = scratch.cursor;
  cursor.set(cnt.subarray(0, nMasters));
  for (let i = lo; i < hi; i++) {
    const idx = order[i];
    sorted[cursor[m[idx]]++] = idx;
  }
  return { groups, sorted, rectTotal };
}

// ---------------------------------------------------------------- tile write
function buildInstanceTile(gen, z, tx, ty, tileSize, groups, sorted, rectTotal) {
  const { x, y, m, o } = gen.instances;
  const count = sorted.length;
  const groupsOff = F.T_HEADER_BYTES;
  const dataOff = groupsOff + groups.length * F.GROUP_BYTES;
  const total = dataOff + count * F.INSTANCE_BYTES;

  const buf = Buffer.alloc(total);
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, total >> 2);
  const i32 = new Int32Array(buf.buffer, buf.byteOffset, total >> 2);

  const originX = tx * tileSize, originY = ty * tileSize;
  let minX = 0x7fffffff, minY = 0x7fffffff, maxX = -0x80000000, maxY = -0x80000000;

  let p = dataOff >> 2;
  for (let i = 0; i < count; i++) {
    const idx = sorted[i];
    const lx = x[idx] - originX, ly = y[idx] - originY;
    const box = orientedBox(gen.masters[m[idx]], o[idx]);
    if (lx < minX) minX = lx;
    if (ly < minY) minY = ly;
    if (lx + box.w > maxX) maxX = lx + box.w;
    if (ly + box.h > maxY) maxY = ly + box.h;
    i32[p    ] = lx;
    i32[p + 1] = ly;
    i32[p + 2] = (m[idx] & 0xffff) | ((o[idx] & 0xff) << 16);
    p += 3;
  }
  if (count === 0) { minX = minY = maxX = maxY = 0; }

  u32[0] = F.MAGIC_TILE;
  buf.writeUInt16LE(F.VERSION, 4);
  buf.writeUInt16LE(F.TILE_KIND.INSTANCES, 6);
  buf.writeUInt8(z, 8);
  buf.writeUInt8(0, 9);
  buf.writeUInt16LE(groups.length, 10);
  u32[3] = count;
  i32[4] = originX;
  i32[5] = originY;
  i32[6] = tileSize;
  u32[7] = rectTotal;
  i32[8] = minX; i32[9] = minY; i32[10] = maxX; i32[11] = maxY;
  u32[12] = groupsOff;
  u32[13] = dataOff;
  u32[14] = tx;
  u32[15] = ty;

  let g = groupsOff >> 2;
  for (const gr of groups) {
    u32[g    ] = gr.master;
    u32[g + 1] = gr.start;
    u32[g + 2] = gr.count;
    u32[g + 3] = gr.rects;
    g += 4;
  }
  return buf;
}

function writeTile(dir, z, tx, ty, buf) {
  const d = path.join(dir, 'tiles', String(z), String(tx));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${ty}.bin`), buf);
}

// ---------------------------------------------------------------- main
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });

  process.stdout.write(`generating ${fmt(opts.count)} instances (seed ${opts.seed})... `);
  const gen = layout.generate(opts);
  const n = gen.instances.n;
  console.log(`${gen.genMs}ms`);
  console.log(`  die         ${um(gen.dieW)} x ${um(gen.dieH)}  (${gen.numRows} rows)`);
  console.log(`  instances   ${fmt(n)}  = ${fmt(gen.stdCount)} std + ${fmt(gen.pwrCount)} power + ${gen.macroCount} macros`);
  console.log(`  masters     ${gen.masters.length}, ${fmt(gen.rects.length / 8)} rects, ${gen.meanRects.toFixed(1)} rects/instance avg`);

  // --- pyramid geometry. Deepest level holds ~perTile instances per tile.
  const maxZ = Math.max(0, Math.ceil(Math.log2(Math.sqrt(n / opts.perTile))));
  const tilesPerSide = 1 << maxZ;
  const span = Math.max(gen.dieW, gen.dieH);
  const tileSize = Math.ceil(span / tilesPerSide / layout.SITE_W) * layout.SITE_W;
  const worldSize = tileSize * tilesPerSide;
  console.log(`  pyramid     maxZ ${maxZ}, ${tilesPerSide}x${tilesPerSide} deepest tiles of ${um(tileSize)}, world ${um(worldSize)}`);

  const mInfo = writeMasters(outDir, gen);
  console.log(`  masters.bin ${fmt(mInfo.bytes)} bytes`);

  const t0 = Date.now();
  const b = bucketDeepest(gen, tilesPerSide, tileSize);
  const nMasters = gen.masters.length;
  const scratch = {
    cnt: new Int32Array(nMasters + 1),
    cursor: new Int32Array(nMasters),
    sorted: new Int32Array(n),
  };

  // Which deepest tiles to write. Step 1 emits only the busiest one, to prove
  // the round trip before the pyramid exists.
  let picks = [];
  for (let t = 0; t < b.nTiles; t++) {
    const c = b.end[t] - b.start[t];
    if (c > 0) picks.push({ t, c });
  }
  const nonEmpty = picks.length;
  if (opts.oneTile) {
    picks.sort((a, q) => q.c - a.c);
    picks = picks.slice(0, 1);
  }

  const written = [];
  let bytes = 0;
  for (const pick of picks) {
    const tx = pick.t % tilesPerSide, ty = (pick.t / tilesPerSide) | 0;
    const g = groupByMaster(gen, b.order, b.start[pick.t], b.end[pick.t], nMasters, scratch);
    const buf = buildInstanceTile(gen, maxZ, tx, ty, tileSize, g.groups, g.sorted, g.rectTotal);
    writeTile(outDir, maxZ, tx, ty, buf);
    bytes += buf.length;
    written.push({ z: maxZ, x: tx, y: ty, count: pick.c, groups: g.groups.length, rects: g.rectTotal, bytes: buf.length });
  }
  console.log(`  tiles       ${fmt(written.length)} written / ${fmt(nonEmpty)} non-empty, ${fmt(bytes)} bytes, ${Date.now() - t0}ms`);

  const manifest = {
    version: F.VERSION,
    seed: opts.seed,
    dbuPerMicron: layout.DBU_PER_MICRON,
    rowHeight: layout.ROW_H,
    siteWidth: layout.SITE_W,
    die: { w: gen.dieW, h: gen.dieH },
    world: { size: worldSize },
    maxZ,
    instanceCount: n,
    masterCount: mInfo.masterCount,
    rectCount: mInfo.rectCount,
    rectTexWidth: F.RECT_TEX_WIDTH,
    meanRectsPerInstance: +gen.meanRects.toFixed(2),
    partial: opts.oneTile,
    levels: [{
      z: maxZ,
      kind: 'instances',
      tilesPerSide,
      tileSize,
      tiles: written.map(t => [t.x, t.y]),
    }],
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  for (const t of written.slice(0, 4))
    console.log(`  tile ${t.z}/${t.x}/${t.y}  ${fmt(t.count)} instances in ${t.groups} master groups, ${fmt(t.rects)} rects, ${fmt(t.bytes)} bytes`);
  console.log(`  -> ${outDir}`);
}

main();
