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
const layout = require('./layout.js');
const P = require('./pyramid.js');
const F = require('./format.js');

// ---------------------------------------------------------------- cli
function parseArgs(argv) {
  const o = {
    count: 1000000, out: 'data', seed: 42, perTile: 4096,
    densityLo: 0.40, densityHi: 0.95, oneTile: false,
    buckets: F.DEFAULT_BUCKETS, strapAlign: false,
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
  --buckets N     rect-count buckets to derive, = deep draw calls      [8]
  --strap-align   snap power straps to deepest-tile boundaries         [off]
  --one-tile      emit only the busiest deepest-level tile`);
}

const fmt = n => n.toLocaleString('en-US');
const um = nm => (nm / 1000).toFixed(1) + 'um';
const mb = b => (b / 1048576).toFixed(1) + ' MB';

// Level entry for a level that was skipped (--one-tile), so the manifest still
// describes the pyramid's shape.
function emptyLevel(L, side) {
  return {
    z: L.z, kind: F.KIND_NAME[L.kind], tilesPerSide: side, tileSize: L.tileSize,
    tileCount: 0, recordBytes: F.RECORD_BYTES[L.kind], rectTotal: 0,
    p95PerTile: L.p95, maxBuckets: 0, maxOverhang: 0, overflow: null,
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
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(opts.out);
  fs.rmSync(path.join(outDir, 'tiles'), { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  process.stdout.write(`generating ${fmt(opts.count)} instances (seed ${opts.seed})... `);
  const gen = layout.generate(opts);
  const n = gen.instances.n;
  console.log(`${gen.genMs}ms`);
  console.log(`  die         ${um(gen.dieW)} x ${um(gen.dieH)}  (${gen.numRows} rows)`);
  console.log(`  instances   ${fmt(n)} = ${fmt(gen.stdCount)} cells + ${fmt(gen.pwrCount)} power + ${gen.macroCount} macros` +
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

  // --- far levels need a density mip chain plus the structures worth keeping
  // sharp. Both are built once and shared across every far level.
  const farLevels = levels.filter(L => L.kind === F.TILE_KIND.FAR);
  let mips = null, structures = null;
  if (farLevels.length) {
    const tf = Date.now();
    const zFarMax = Math.max(...farLevels.map(L => L.z));
    mips = P.buildDensityMips(gen, worldSize, zFarMax);
    structures = P.collectStructures(gen);
    console.log(`  density     ${F.BLOCK_GRID << zFarMax}^2 raster, ${structures.macros.length} macros, ` +
                `${structures.straps.length} merged straps, ${Date.now() - tf}ms`);
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

  // --- write every level
  const tw = Date.now();
  const manifestLevels = [];
  let totalTiles = 0, totalBytes = 0;

  // --one-tile writes just the busiest deepest tile, for quick round-trip checks.
  let onlyTile = -1;
  if (opts.oneTile) {
    const deepest = levels[levels.length - 1].counts;
    let best = 0;
    for (let i = 0; i < deepest.length; i++) if (deepest[i] > best) { best = deepest[i]; onlyTile = i; }
  }

  for (const L of levels) {
    const side = L.tilesPerSide;
    const present = new Uint8Array(side * side);
    let tiles = 0, bytes = 0, rects = 0, bucketsMax = 0, overhang = 0;
    if (opts.oneTile && L.z !== maxZ) { manifestLevels.push(emptyLevel(L, side)); continue; }

    // Features too big for this level's tiles are promoted out of the tile grid
    // into one overflow list per level. Without this a single macro sets the
    // level's content bleed and the viewer fetches an enormous ring of tiles.
    const abstract = L.kind === F.TILE_KIND.FAR;
    const mask = abstract ? null : P.oversizeMask(gen.masters, L.tileSize);
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
        if (out.bucketCount > bucketsMax) bucketsMax = out.bucketCount;

        // How far this level's geometry can reach outside its tile. The viewer
        // expands its cull rect by this, so no tile is skipped whose content
        // bleeds into view. Overflow promotion is what keeps it small.
        const hdr = new Int32Array(out.buf.buffer, out.buf.byteOffset, 16);
        const over = Math.max(0, hdr[10] - L.tileSize, hdr[11] - L.tileSize, -hdr[8], -hdr[9]);
        if (over > overhang) overhang = over;
      }
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
    meanCellWidth: Math.round(gen.meanW),
    blockGrid: F.BLOCK_GRID,
    rectBudget: F.RECT_BUDGET,
    bucketCaps: caps,
    bucketPadding: +cost.waste.toFixed(4),
    oversizeFrac: F.OVERSIZE_FRAC,
    maxRectsPerMaster: maxRects,
    strapAligned: gen.strapAligned,
    partial: opts.oneTile,
    levels: manifestLevels,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`  -> ${outDir}`);
}

main();
