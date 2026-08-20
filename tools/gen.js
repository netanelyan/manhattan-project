#!/usr/bin/env node
'use strict';
// Manhattan tile generator.
//
//   node tools/gen.js [--count N] [--out DIR] [--seed S] [--per-tile N] [--one-tile]
//
// Writes masters.bin, the tiles/{z}/{x}/{y}.bin pyramid and manifest.json.
// Byte layouts are documented in docs/tile-format.md. Core Node only.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const layout = require('./layout.js');
const P = require('./pyramid.js');
const C = require('./chip.js');
const F = require('./format.js');
const IX = require('./pindex.js');

// ---------------------------------------------------------------- cli
function parseArgs(argv) {
  const o = {
    count: 1000000, out: 'data', seed: 42, perTile: 4096,
    densityLo: 0.40, densityHi: 0.95, oneTile: false,
    buckets: F.DEFAULT_BUCKETS, strapAlign: false,
    blocks: 70, blockOrient: 'rows', blockGap: 0.01, verify: true, lazy: false,
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
      case '--buckets':   o.buckets = +next(); break;
      case '--strap-align': o.strapAlign = true; break;
      case '--blocks':    o.blocks = +next(); break;
      case '--block-orient': o.blockOrient = next(); break;
      case '--block-gap': o.blockGap = +next(); break;
      case '--one-tile':  o.oneTile = true; break;
      case '--lazy':      o.lazy = true; break;
      case '--no-verify': o.verify = false; break;
      case '-h': case '--help': usage(); process.exit(0);
      default: console.error(`unknown flag ${a}`); usage(); process.exit(1);
    }
  }
  if (!(o.blocks >= 1 && o.blocks <= 4096)) {
    console.error('--blocks must be between 1 and 4096');
    process.exit(1);
  }
  if (!['none', 'rows', 'all'].includes(o.blockOrient)) {
    console.error("--block-orient must be none, rows or all");
    process.exit(1);
  }
  if (!(o.count >= 100000 && o.count <= 50000000)) {
    console.error('--count must be between 100k and 50M');
    process.exit(1);
  }
  // Every remaining knob feeds a division or a log somewhere downstream, and a
  // zero or a NaN does not surface as an error - it surfaces as a pyramid with
  // no levels in it, or as a loop that never ends. --per-tile 0 makes maxZ
  // infinite; --density 0:0 divides the die area by a mean density of zero and
  // hangs filling an infinitely tall die; --buckets 0 derives an empty cap list
  // and writes deep tiles that no viewer can read. So the range is stated here,
  // once, where it can still be said in one line.
  const range = (v, lo, hi, msg) => {
    if (!(Number.isFinite(v) && v >= lo && v <= hi)) { console.error(msg); process.exit(1); }
  };
  range(o.perTile, 64, 1000000, '--per-tile must be between 64 and 1M');
  range(o.buckets, 1, 32, '--buckets must be between 1 and 32');
  range(o.seed, 0, 4294967295, '--seed must be an integer between 0 and 2^32-1');
  range(o.blockGap, 0, 0.99, '--block-gap must be between 0 and 0.99');
  if (!(Number.isFinite(o.densityLo) && Number.isFinite(o.densityHi) &&
        o.densityLo > 0 && o.densityLo <= o.densityHi && o.densityHi <= 1)) {
    console.error('--density must be LO:HI with 0 < LO <= HI <= 1');
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

  --count N       total instances, 100k .. 50M (accepts 1.5M / 500k)   [1M]
  --out DIR       output directory                                     [data]
  --seed S        PRNG seed, 0 .. 2^32-1                               [42]
  --per-tile N    target instances per deepest-level tile, 64 .. 1M    [4096]
  --density LO:HI row density range, 0 < LO <= HI <= 1                 [0.40:0.95]
  --buckets N     rect-count buckets to derive = deep draw calls, 1..32 [8]
  --strap-align   snap power straps to deepest-tile boundaries         [off]
  --blocks N      block instances in the synthetic chip, 1 .. 4096     [70]
  --block-orient  none | rows (mirror alternate rows) | all            [rows]
  --block-gap F   routing channel between blocks, fraction 0 .. 0.99   [0.01]
  --one-tile      emit only the busiest deepest-level tile
  --lazy          write only the far levels; index the placements instead, and
                  produce deep and mid tiles on demand (see tools/lazy.js)
  --no-verify     skip the verify pass that normally follows generation`);
}

const fmt = n => n.toLocaleString('en-US');
const um = nm => (nm / 1000).toFixed(1) + 'um';
const mb = b => (b / 1048576).toFixed(1) + ' MB';

// The gate on laziness, run before generation finishes.
//
// The claim the whole scheme rests on is that a tile produced from the index is
// the tile full generation would have written. Nothing downstream can check
// that: a tile built from wrong coordinates still has a consistent header, a
// consistent content box and a consistent bucket table, so it verifies happily
// and draws in the wrong place. The only thing that catches it is building the
// same tile both ways and comparing the bytes - and the one moment both paths
// are available at once is here, with the placement list still in memory and
// the index just written.
//
// So a sample of tiles from every lazy level is built twice and compared. It
// found exactly the bug it was written for: a tile origin that is not a
// multiple of the row height makes (y - origin) off-grid even though every y is
// on it, and every tile below the first row of the design was 200nm out.
const PROVE_SAMPLE = 24;

function proveIndex(outDir, gen, bucket, levels, keepIdx, oversizeByLevel, maxZ, caps,
                    scratch, gather, manifestLevels) {
  const t0 = Date.now();
  const { TileFactory } = require('./lazy.js');
  const factory = new TileFactory(outDir);
  const openMs = Date.now() - t0;
  let checked = 0;
  for (let li = 0; li < levels.length; li++) {
    const L = levels[li];
    if (!keepIdx.has(li) || L.kind === F.TILE_KIND.FAR) continue;
    const side = L.tilesPerSide;
    const ml = manifestLevels.find(e => e.z === L.z);
    if (!ml || !ml.lazy) continue;
    const cov = Buffer.from(ml.coverage, 'base64');
    const live = [];
    for (let i = 0; i < side * side; i++) if ((cov[i >> 3] >> (i & 7)) & 1) live.push(i);
    const step = Math.max(1, Math.floor(live.length / PROVE_SAMPLE));
    for (let s = 0; s < live.length; s += step) {
      const idx = live[s], X = idx % side, Y = (idx / side) | 0;
      const m = P.collectTile(bucket, maxZ, L.z, X, Y, gather, oversizeByLevel[li], gen.instances.m);
      const eager = L.kind === F.TILE_KIND.DEEP
        ? P.buildDeepTile(gen, gather, m, L.z, X, Y, L.tileSize, scratch, caps)
        : P.buildMidTile(gen, gather, m, L.z, X, Y, L.tileSize);
      const lazyBuf = factory.build(L.z, X, Y);
      if (!lazyBuf || !eager.buf.equals(lazyBuf)) {
        console.error(`  the index does not reproduce z${L.z}/${X}/${Y}: ` +
                      `${eager.buf.length} bytes written vs ${lazyBuf ? lazyBuf.length : 'nothing'} produced`);
        process.exit(1);
      }
      checked++;
    }
  }
  factory.index.close();
  console.log(`              ${checked} sampled tiles rebuilt from the index and compared byte for ` +
              `byte with what full generation writes (${Date.now() - t0}ms, ${openMs}ms of it opening)`);
  return checked;
}

// Level entry for a level that was skipped (--one-tile), so the manifest still
// describes the pyramid's shape.
function emptyLevel(L, side) {
  return {
    z: L.z, kind: F.KIND_NAME[L.kind], tilesPerSide: side, tileSize: L.tileSize,
    tileCount: 0, recordBytes: F.RECORD_BYTES[L.kind], rectTotal: 0,
    p95PerTile: L.p95, rectP95PerTile: 0, maxBuckets: 0, maxOverhang: 0, overflow: null,
    coverage: Buffer.alloc(Math.ceil(side * side / 8)).toString('base64'),
  };
}

// ---------------------------------------------------------------- masters.bin
function writeMasters(dir, gen) {
  const nM = gen.masters.length, nR = gen.rects.length / 8;
  const mastersOff = F.M_HEADER_BYTES;
  const rectsOff = mastersOff + nM * F.MASTER_BYTES;
  const total = rectsOff + nR * F.RECT_BYTES;

  const buf = Buffer.alloc(total);
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, total >> 2);
  const i32 = new Int32Array(buf.buffer, buf.byteOffset, total >> 2);

  u32[0] = F.MAGIC_MASTERS;
  buf.writeUInt16LE(F.VERSION, 4);
  buf.writeUInt16LE(0, 6);
  u32[2] = nM; u32[3] = nR; u32[4] = mastersOff; u32[5] = rectsOff;
  u32[6] = layout.DBU_PER_MICRON; u32[7] = layout.ROW_H;

  let p = mastersOff >> 2;
  for (const m of gen.masters) {
    i32[p] = m.rectStart; i32[p + 1] = m.rectCount;
    i32[p + 2] = m.w; i32[p + 3] = m.h;
    i32[p + 4] = m.klass; i32[p + 5] = m.rowH;
    i32[p + 6] = 0; i32[p + 7] = 0;
    p += 8;
  }
  i32.set(gen.rects, rectsOff >> 2);
  fs.writeFileSync(path.join(dir, 'masters.bin'), buf);
  return { bytes: total, masterCount: nM, rectCount: nR };
}

// ---------------------------------------------------------------- main
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // The ladder and the block -> chip transform are the viewer's own modules,
  // imported rather than reimplemented: they are the arithmetic both sides have
  // to agree on exactly, and two copies would be two chances to disagree.
  const LOD = await import('../src/lod.js');
  const { Chip } = await import('../src/chip.js');
  const outDir = path.resolve(opts.out);
  fs.rmSync(path.join(outDir, 'tiles'), { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  process.stdout.write(`generating ${fmt(opts.count)} instances (seed ${opts.seed})... `);
  const gen = layout.generate(opts);
  const n = gen.instances.n;
  console.log(`${gen.genMs}ms`);
  console.log(`  die         ${um(gen.dieW)} x ${um(gen.dieH)}  (${gen.numRows} rows)`);
  console.log(`  instances   ${fmt(n)} = ${fmt(gen.stdCount - gen.fillCount)} logic + ${fmt(gen.fillCount)} filler + ` +
              `${fmt(gen.pwrCount)} power + ${gen.macroCount} macros` +
              `  (straps ${gen.strapAligned ? 'tile-aligned' : 'unaligned'}, ${um(gen.strapSeg)} segments)`);
  console.log(`  masters     ${fmt(gen.masters.length)}, ${fmt(gen.rects.length / 8)} rects, ` +
              `${gen.meanRects.toFixed(1)} rects/placement avg, max ${gen.masters.reduce((a, m) => Math.max(a, m.rectCount), 0)} per master`);

  // Pyramid geometry is decided inside layout.generate, because power strap
  // segment length is tied to the deepest tile size. World is square and an
  // exact multiple of 2^maxZ, so every level's tile size is a whole number of nm.
  const { maxZ, tilesPerSide, tileSize, worldSize } = gen;
  const maxRects = gen.masters.reduce((a, m) => Math.max(a, m.rectCount), 0);

  // Bucket caps come from this design's own placement-weighted rect-count
  // histogram, solved exactly. Hardcoding them would be fitting to whatever
  // distribution the generator happens to produce; a real library spikes
  // somewhere else entirely.
  const caps = F.deriveCaps(gen.rectHist, opts.buckets);
  // The histogram is over cells the placer draws from, which is not the whole
  // library: macros and power straps are placed too, and they land in the
  // overflow list, which is bucketed with these same caps. On this generator
  // the widest standard cell has more rectangles than any macro, so the last
  // cap covers them by luck rather than by construction - shrink the cell
  // library and it stops being true, and the overflow tile is then written
  // with a bucket id off the end of the list. The last cap is the library
  // maximum by definition, so say so.
  if (caps[caps.length - 1] < maxRects) caps[caps.length - 1] = maxRects;
  const cost = F.capCost(gen.rectHist, caps);

  const mInfo = writeMasters(outDir, gen);
  console.log(`  masters.bin ${fmt(mInfo.bytes)} bytes`);

  const t0 = Date.now();
  const bucket = P.bucketDeepest(gen, tilesPerSide, tileSize);
  const levels = P.planLevels(bucket, maxZ, tileSize, worldSize, gen.meanRects, gen.meanW);

  console.log(`  pyramid     maxZ ${maxZ}, world ${um(worldSize)}, bucketed in ${Date.now() - t0}ms`);
  console.log('    z   kind   tiles      tile size   p95/tile   cell px   est rects on screen');
  for (const L of levels) {
    console.log(`    ${String(L.z).padStart(2)}  ${F.KIND_NAME[L.kind].padEnd(5)} ` +
      `${String(L.nonEmpty).padStart(6)}/${String(L.tilesPerSide ** 2).padEnd(6)} ` +
      `${um(L.tileSize).padStart(9)}  ${fmt(L.p95).padStart(9)}  ${L.cellPx.toFixed(2).padStart(7)}   ` +
      (L.cost === null ? `${F.BLOCK_GRID}x${F.BLOCK_GRID} blocks` : fmt(Math.round(L.cost))));
  }

  // A level is far when one rectangle per placement already blows the budget.
  // If that is true of every level - which happens when the placements are
  // packed into a small part of the world, because the pyramid is sized from
  // --count on the assumption that they are spread over it - then no level
  // holds a placement, nothing on disk carries a cell, and no zoom can ever
  // show one. The tiles that do get written are consistent and verify happily,
  // which is what makes this worth failing on here rather than discovering in
  // the viewer.
  const deepest = levels[levels.length - 1];
  if (!levels.some(L => L.kind !== F.TILE_KIND.FAR)) {
    console.error(`  every level came out far: the deepest tile holds ${fmt(deepest.p95)} placements ` +
                  `at ${deepest.cellPx.toFixed(2)} px per cell, which is over the ` +
                  `${fmt(F.RECT_BUDGET)} rectangle budget even at one outline each, so no level ` +
                  `carries placements and the cells would be nowhere on disk.`);
    console.error(`  the pyramid is sized from --count / --per-tile assuming placements spread over ` +
                  `the die; lower --per-tile to cut the deepest tile down.`);
    process.exit(1);
  }

  // --- far levels need a density mip chain plus the structures worth keeping
  // sharp. Both are built once and shared across every far level.
  const farLevels = levels.filter(L => L.kind === F.TILE_KIND.FAR);
  let mips = null, structures = null, densityLoHi = [0, 1];
  if (farLevels.length) {
    const tf = Date.now();
    const zFarMax = Math.max(...farLevels.map(L => L.z));
    mips = P.buildDensityMips(gen, worldSize, zFarMax);
    densityLoHi = P.densityRange(mips, zFarMax);
    structures = P.collectStructures(gen);
    console.log(`  density     ${F.BLOCK_GRID << zFarMax}^2 raster, ${structures.macros.length} macros, ` +
                `${structures.straps.length} merged straps, logic density p5..p95 ` +
                `${(100 * densityLoHi[0]).toFixed(0)}..${(100 * densityLoHi[1]).toFixed(0)}%, ${Date.now() - tf}ms`);
  }

  // --- scratch sized for the largest tile that gathers instances
  let maxGather = 0;
  for (const L of levels) {
    if (L.kind === F.TILE_KIND.FAR) continue;
    for (const c of L.counts) if (c > maxGather) maxGather = c;
  }
  const scratch = {
    cnt: new Int32Array(caps.length + 1),
    cursor: new Int32Array(caps.length),
    sorted: new Int32Array(maxGather),
  };
  const gather = new Int32Array(maxGather);
  console.log(`  buckets     derived [${caps.join(', ')}] -> ${caps.length} draw calls per frame, ` +
              `independent of the ${fmt(gen.masters.length)}-master library`);
  console.log(`              ${(100 * cost.waste).toFixed(1)}% padding ` +
              `(fixed [8,16,32,64] would be ${(100 * F.capCost(gen.rectHist, [8, 16, 32, 64]).waste).toFixed(1)}%)`);

  // --- what each level costs to draw, and which levels are worth writing.
  //
  // The ladder has to be solved before anything is written: a level whose
  // window between its own switch-out scale and the next finer level's is empty
  // can never be selected at any zoom, and writing it is disk nothing can read.
  // Costs come from the placement list, not from tiles on disk, so this is
  // decided without paying for it first.
  const oversizeByLevel = levels.map(L =>
    L.kind === F.TILE_KIND.FAR ? null : P.oversizeMask(gen.masters, L.tileSize));
  const meanCellWidth = Math.round(gen.meanW);
  const costs = levels.map((L, i) => {
    const counts = P.levelRectCounts(gen, bucket, maxZ, L, oversizeByLevel[i], mips, structures, worldSize);
    const ovf = oversizeByLevel[i] ? P.overflowCost(gen, oversizeByLevel[i], L.kind) : { count: 0, rects: 0 };
    return { rectP95: P.p95NonEmpty(counts), ovf };
  });
  // The chip this block is instanced into. The ladder depends on it: a block's
  // coarse levels earn their keep only when many blocks are on screen at once,
  // which is exactly the chip view, and its deep levels are never seen more
  // than one or two instances at a time. Built before anything is written, so
  // a level no zoom can select is never written.
  const chipDoc = C.buildChip(opts, {
    version: F.VERSION, world: { size: worldSize }, die: { w: gen.dieW, h: gen.dieH }, maxZ,
  });
  const chipGeom = new Chip(chipDoc, worldSize);
  const view = LOD.viewOf(F.REF_VIEW.w, F.REF_VIEW.h, F.MAX_VIS_TILES, chipGeom);
  const lodManifest = {
    rectBudget: F.RECT_BUDGET,
    meanCellWidth,
    lod: { minCellPx: F.MIN_CELL_PX },
    levels: levels.map((L, i) => ({
      z: L.z, kind: F.KIND_NAME[L.kind], tileSize: L.tileSize, tilesPerSide: L.tilesPerSide,
      rectP95PerTile: costs[i].rectP95,
      overflow: costs[i].ovf.count ? { rectCount: costs[i].ovf.rects } : null,
    })),
  };
  // --one-tile is a round-trip check on one tile, not a pyramid; leave its
  // level set alone or there would be nothing to check.
  const sel = opts.oneTile
    ? { keep: levels.map((_, i) => i), ladder: LOD.deriveLadder(lodManifest, view) }
    : LOD.selectableLevels(lodManifest, view);
  const keepIdx = new Set(sel.keep);
  const dropped = levels.filter((_, i) => !keepIdx.has(i));
  const switchPoints = sel.ladder;

  console.log(`  lod ladder  ${F.REF_VIEW.w}x${F.REF_VIEW.h} reference viewport, ${fmt(opts.blocks)} block ` +
              `instance${opts.blocks === 1 ? '' : 's'}; switch-in is ${F.LOD_HYSTERESIS}x switch-out, and the ` +
              `columns are quoted at switch-out, where the level costs most`);
  console.log('    z   kind   switch-out px/nm   nm/px   binds      blocks    tiles   rects on screen');
  for (const p of switchPoints) {
    const s0 = p.minScale;
    const t = s0 > 0 ? LOD.tilesOnScreen(view, p.tilesPerSide, p.tileSize, s0) : null;
    const r = t ? LOD.rectsOnScreen(view, p, s0) : null;
    console.log(`    ${String(p.z).padStart(2)}  ${p.kind.padEnd(5)} ${s0.toExponential(3).padStart(15)} ` +
      `${(s0 ? (1 / s0).toFixed(0) : '-').padStart(7)}   ${p.bound.padEnd(9)} ` +
      `${(t ? t.instances.toFixed(1) : '-').padStart(7)} ${(t ? t.tiles.toFixed(1) : '-').padStart(8)} ` +
      `${(r === null ? '-' : fmt(Math.round(r))).padStart(17)}`);
  }
  if (dropped.length) {
    const saved = dropped.reduce((a, L) => a + (L.kind === F.TILE_KIND.FAR ? 0 : F.RECORD_BYTES[L.kind] * n), 0);
    console.log(`                not written: ${dropped.map(L => 'z' + L.z + ' ' + F.KIND_NAME[L.kind]).join(', ')} ` +
                `- no zoom can select ${dropped.length > 1 ? 'them' : 'it'}, the next finer level takes over at the ` +
                `same scale (saves ~${mb(saved)})`);
  }

  // --- write every level
  const tw = Date.now();
  const manifestLevels = [];
  let totalTiles = 0, totalBytes = 0, lazyTiles = 0;

  // --one-tile writes just the busiest deepest tile, for quick round-trip checks.
  let onlyTile = -1;
  if (opts.oneTile) {
    const deepest = levels[levels.length - 1].counts;
    let best = 0;
    for (let i = 0; i < deepest.length; i++) if (deepest[i] > best) { best = deepest[i]; onlyTile = i; }
  }

  // Which levels are written now and which are indexed for later.
  //
  // A deep or mid level holds every placement exactly once, so each one is a
  // full copy of the placement array on disk - and the pyramid writes two of
  // them. The index is one copy at a third of the bytes and serves every such
  // level, so anything that carries placements is better produced on demand
  // than written. Far levels are not placements at all: they are the merged
  // density map, they are what the viewer opens with, and they are small. They
  // stay eager, and so does every level's overflow list, which is
  // always-resident by definition and could not be lazily fetched anyway.
  const isLazy = L => opts.lazy && !opts.oneTile && L.kind !== F.TILE_KIND.FAR;

  for (let li = 0; li < levels.length; li++) {
    const L = levels[li];
    if (!keepIdx.has(li)) continue;
    const side = L.tilesPerSide;
    const present = new Uint8Array(side * side);
    let tiles = 0, bytes = 0, rects = 0, bucketsMax = 0, overhang = 0;
    const perTile = [];
    if (opts.oneTile && L.z !== maxZ) { manifestLevels.push(emptyLevel(L, side)); continue; }

    // Features too big for this level's tiles are promoted out of the tile grid
    // into one overflow list per level. Without this a single macro sets the
    // level's content bleed and the viewer fetches an enormous ring of tiles.
    const abstract = L.kind === F.TILE_KIND.FAR;
    const mask = oversizeByLevel[li];
    let overflow = null;
    if (mask) {
      const oidx = P.collectOverflow(gen, mask);
      if (oidx.length) {
        if (oidx.length > scratch.sorted.length) scratch.sorted = new Int32Array(oidx.length);
        overflow = P.buildOverflowTile(gen, oidx, L.z, L.kind, worldSize, scratch, caps);
        fs.mkdirSync(path.join(outDir, 'tiles', String(L.z)), { recursive: true });
        fs.writeFileSync(path.join(outDir, 'tiles', String(L.z), 'overflow.bin'), overflow.buf);
        bytes += overflow.buf.length;
        rects += overflow.rectCount;
      }
    }

    // A lazy level writes no tiles. Everything the manifest says about it -
    // which tiles exist, what a tile costs in rectangles, how far its content
    // bleeds - is a property of the placement list, so it is computed here in
    // one pass and checked against the costing pass exactly as written tiles
    // are. tools/lazy.js produces the tiles themselves, on request.
    if (isLazy(L)) {
      const st = P.levelTileStats(gen, bucket, maxZ, L, mask, caps);
      if (st.rectP95 !== costs[li].rectP95) {
        console.error(`  costing pass disagrees with the lazy level plan at z${L.z}: ` +
                      `${costs[li].rectP95} predicted, ${st.rectP95} planned`);
        process.exit(1);
      }
      manifestLevels.push({
        z: L.z, kind: F.KIND_NAME[L.kind], tilesPerSide: side, tileSize: L.tileSize,
        tileCount: st.tiles, recordBytes: F.RECORD_BYTES[L.kind],
        rectTotal: st.rectTotal + (overflow ? overflow.rectCount : 0),
        p95PerTile: L.p95, rectP95PerTile: st.rectP95,
        maxBuckets: st.maxBuckets, maxOverhang: st.overhang,
        overflow: overflow ? { count: overflow.count, rectCount: overflow.rectCount, bytes: overflow.buf.length } : null,
        coverage: Buffer.from(P.coverageBitmap(st.present, side)).toString('base64'),
        lazy: true,
      });
      lazyTiles += st.tiles;
      totalTiles += overflow ? 1 : 0; totalBytes += bytes;
      console.log(`    z${L.z} ${F.KIND_NAME[L.kind].padEnd(5)} ${fmt(st.tiles).padStart(6)} tiles  ` +
        `${'on demand'.padStart(9)}  ${fmt(st.rectTotal + (overflow ? overflow.rectCount : 0)).padStart(12)} rects  bleed ${um(st.overhang).padStart(8)}` +
        (overflow ? `  overflow ${fmt(overflow.count)}` : '') +
        (st.maxBuckets ? `  ${st.maxBuckets} buckets/tile` : ''));
      continue;
    }

    for (let Y = 0; Y < side; Y++) {
      for (let X = 0; X < side; X++) {
        const idx = Y * side + X;
        if (onlyTile >= 0 && idx !== onlyTile) continue;
        let out;
        if (abstract) {
          out = P.buildFarTile(mips, structures, L.z, X, Y, L.tileSize, worldSize);
          if (out.rectCount === 0) continue;                   // nothing here
        } else {
          if (L.counts[idx] === 0) continue;
          const m = P.collectTile(bucket, maxZ, L.z, X, Y, gather, mask, gen.instances.m);
          if (m === 0) continue;                               // all promoted
          out = L.kind === F.TILE_KIND.DEEP
            ? P.buildDeepTile(gen, gather, m, L.z, X, Y, L.tileSize, scratch, caps)
            : P.buildMidTile(gen, gather, m, L.z, X, Y, L.tileSize);
        }

        const d = path.join(outDir, 'tiles', String(L.z), String(X));
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, `${Y}.bin`), out.buf);
        present[Y * side + X] = 1;
        tiles++; bytes += out.buf.length; rects += out.rectCount;
        perTile.push(out.rectCount);
        if (out.bucketCount > bucketsMax) bucketsMax = out.bucketCount;

        // How far this level's geometry can reach outside its tile. The viewer
        // expands its cull rect by this, so no tile is skipped whose content
        // bleeds into view. Overflow promotion is what keeps it small.
        const hdr = new Int32Array(out.buf.buffer, out.buf.byteOffset, 16);
        const over = Math.max(0, hdr[10] - L.tileSize, hdr[11] - L.tileSize, -hdr[8], -hdr[9]);
        if (over > overhang) overhang = over;
      }
    }

    // The runtime level choice budgets in rectangles, so it needs the p95 of
    // what a tile at this level actually costs - not the p95 placement count
    // planLevels worked from, which predates knowing the real rect spread.
    perTile.sort((a, b) => a - b);
    const rectP95 = perTile.length
      ? perTile[Math.min(perTile.length - 1, Math.floor(perTile.length * 0.95))] : 0;
    // The ladder was solved from the costing pass, before any of this existed.
    // If the two disagree the shipped switch points are wrong, so it is a hard
    // failure rather than a warning.
    if (!opts.oneTile && rectP95 !== costs[li].rectP95) {
      console.error(`  costing pass disagrees with what was written at z${L.z}: ` +
                    `${costs[li].rectP95} predicted, ${rectP95} actual`);
      process.exit(1);
    }

    manifestLevels.push({
      z: L.z,
      kind: F.KIND_NAME[L.kind],
      tilesPerSide: side,
      tileSize: L.tileSize,
      tileCount: tiles,
      recordBytes: F.RECORD_BYTES[L.kind],
      rectTotal: rects,
      p95PerTile: L.p95,
      rectP95PerTile: rectP95,
      maxBuckets: bucketsMax,
      maxOverhang: overhang,
      overflow: overflow ? { count: overflow.count, rectCount: overflow.rectCount, bytes: overflow.buf.length } : null,
      coverage: Buffer.from(P.coverageBitmap(present, side)).toString('base64'),
    });
    totalTiles += tiles + (overflow ? 1 : 0); totalBytes += bytes;
    console.log(`    z${L.z} ${F.KIND_NAME[L.kind].padEnd(5)} ${fmt(tiles).padStart(6)} tiles  ` +
      `${mb(bytes).padStart(9)}  ${fmt(rects).padStart(12)} rects  bleed ${um(overhang).padStart(8)}` +
      (overflow ? `  overflow ${fmt(overflow.count)}` : '') +
      (bucketsMax ? `  ${bucketsMax} buckets/tile` : ''));
  }
  console.log(`  tiles       ${fmt(totalTiles)} written, ${mb(totalBytes)}, ${((Date.now() - tw) / 1000).toFixed(1)}s`);

  // The index. Written last, because it is only worth anything once the levels
  // that need it know they are lazy.
  let indexInfo = null;
  if (opts.lazy && !opts.oneTile) {
    const ti = Date.now();
    const pack = IX.planPacking(gen, tileSize, layout.SITE_W, layout.ROW_H);
    indexInfo = IX.writeIndex(outDir, gen, bucket, pack);
    indexInfo.ms = Date.now() - ti;
    const per = indexInfo.recordBytes;
    console.log(`  index       placements.bin ${mb(indexInfo.bytes)}, ${per} bytes/placement ` +
      (indexInfo.packed
        ? `(${indexInfo.bits} bits: x/${indexInfo.gridX}nm, y/${indexInfo.gridY}nm, master, orient)`
        : '(unpacked: the placement record verbatim)') +
      `, ${(indexInfo.ms / 1000).toFixed(1)}s`);
    const nLazyLevels = manifestLevels.filter(L => L.lazy).length;
    const notWritten = lazyTiles * F.T_HEADER_BYTES + n * F.INSTANCE_BYTES * nLazyLevels;
    console.log(`              ${fmt(lazyTiles)} deep and mid tiles across ${nLazyLevels} level` +
                `${nLazyLevels === 1 ? '' : 's'} produced on demand instead of written ` +
                `(about ${mb(notWritten)} not on disk)`);
  }

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
    blockGrid: F.BLOCK_GRID,
    densityRange: densityLoHi,
    rectBudget: F.RECT_BUDGET,
    bucketCaps: caps,
    meanCellWidth,
    lod: {
      refView: { w: F.REF_VIEW.w, h: F.REF_VIEW.h },
      minCellPx: F.MIN_CELL_PX,
      maxVisibleTiles: F.MAX_VIS_TILES,
      hysteresis: F.LOD_HYSTERESIS,
      solvedFor: {
        instances: chipGeom.count, nx: chipGeom.nx, ny: chipGeom.ny,
        pitchX: chipGeom.pitchX, pitchY: chipGeom.pitchY,
        blockW: chipGeom.blockSize, blockH: chipGeom.blockSize,
      },
      switchPoints: switchPoints.map(p => ({
        z: p.z, bound: p.bound,
        minScale: Number.isFinite(p.minScale) ? +p.minScale.toPrecision(6) : null,
      })),
      shadowed: dropped.map(L => L.z),
    },
    bucketPadding: +cost.waste.toFixed(4),
    oversizeFrac: F.OVERSIZE_FRAC,
    maxRectsPerMaster: maxRects,
    strapAligned: gen.strapAligned,
    partial: opts.oneTile,
    // Absent, not null, when generation was not lazy: a full run's manifest has
    // to stay byte-for-byte what it was before any of this existed.
    ...(indexInfo ? { lazy: { recordBytes: indexInfo.recordBytes, bytes: indexInfo.bytes,
                              packed: indexInfo.packed, gridX: indexInfo.gridX,
                              gridY: indexInfo.gridY } } : {}),
    levels: manifestLevels,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Written after the manifest because the proof reads the design back exactly
  // as the tile server will: through TileFactory, off disk, with no access to
  // anything still in memory here.
  if (indexInfo) {
    indexInfo.checked = proveIndex(outDir, gen, bucket, levels, keepIdx, oversizeByLevel,
                                   maxZ, caps, scratch, gather, manifestLevels);
  }

  // --- the chip: N instances of the block that was just written.
  //
  // Nothing about the block depends on this. The block is tiled once and the
  // chip is a list of transforms over it, which is the whole point: flattened,
  // this chip would be ${n * blocks} placements and N times the bytes on disk.
  fs.writeFileSync(path.join(outDir, 'chip.json'), JSON.stringify(chipDoc, null, 2));
  const flatBytes = totalBytes * opts.blocks;
  console.log(`  chip        ${fmt(opts.blocks)} instances of 1 block, ${chipDoc.grid.cols}x${chipDoc.grid.rows} grid, ` +
              `orient ${opts.blockOrient}, ${um(chipDoc.chip.w)} x ${um(chipDoc.chip.h)} die`);
  console.log(`              ${fmt(opts.blocks * n)} placements at chip level, in ${mb(totalBytes)} of tiles ` +
              `(flattened it would be ~${mb(flatBytes)})`);
  console.log(`  -> ${outDir}`);

  // --- the gate.
  //
  // Generating and verifying used to be two things a person remembered to do in
  // order, which is exactly how a writer and a checker drift apart without
  // anyone noticing: the far tile record grew a filler-density channel where a
  // block-kind enum used to be, and the tiles were correct and the checker was
  // stale for as long as nobody ran both. Now one cannot happen without the
  // other.
  if (opts.verify) {
    console.log('');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'verify.js'), outDir],
                        { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error('generation produced data that does not verify - see above');
      process.exit(r.status || 1);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
