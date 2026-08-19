#!/usr/bin/env node
'use strict';
// Reads the generated pyramid back with the same zero-parse view logic the
// viewer uses, and checks every invariant the viewer relies on.
//
//   node tools/verify.js [dataDir] [--sample N]

const fs = require('fs');
const path = require('path');
const F = require('./format.js');

const args = process.argv.slice(2);
const DIR = path.resolve(args.find(a => !a.startsWith('--')) || 'data');
const sampleIdx = args.indexOf('--sample');
const SAMPLE = sampleIdx >= 0 ? +args[sampleIdx + 1] : Infinity;

let fails = 0;
const seen = new Set();
function check(ok, msg) {
  if (!ok && !seen.has(msg)) {
    if (fails < 25) console.error('  FAIL ' + msg);
    seen.add(msg); fails++;
  }
  return ok;
}
const read = p => {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
check(manifest.version === F.VERSION, `manifest version ${manifest.version}`);
console.log(`manifest    v${manifest.version}, maxZ ${manifest.maxZ}, ` +
            `${manifest.instanceCount.toLocaleString()} placements, world ${manifest.world.size}nm`);

// ---------------------------------------------------------------- masters.bin
const mbuf = read(path.join(DIR, 'masters.bin'));
const mh = new Uint32Array(mbuf, 0, 8);
check(mh[0] === F.MAGIC_MASTERS, 'masters magic');
const masterCount = mh[2], rectCount = mh[3], mastersOff = mh[4], rectsOff = mh[5];
check(mastersOff % 4 === 0 && rectsOff % 4 === 0, 'masters offsets 4-aligned');
check(masterCount === manifest.masterCount, 'masterCount matches manifest');
check(rectsOff + rectCount * F.RECT_BYTES === mbuf.byteLength, 'masters.bin size exact');

const md = new Int32Array(mbuf, mastersOff, masterCount * 8);
const rd = new Int32Array(mbuf, rectsOff, rectCount * 8);
let minR = 1e9, maxR = 0, sumR = 0;
const klass = [0, 0, 0];
for (let m = 0; m < masterCount; m++) {
  const s = md[m * 8], c = md[m * 8 + 1], w = md[m * 8 + 2], h = md[m * 8 + 3];
  check(s >= 0 && s + c <= rectCount, `master ${m} rect range`);
  check(w > 0 && h > 0, `master ${m} bbox`);
  klass[md[m * 8 + 4]]++;
  minR = Math.min(minR, c); maxR = Math.max(maxR, c); sumR += c;
  for (let r = s; r < s + c; r++) {
    const x = rd[r * 8], y = rd[r * 8 + 1], rw = rd[r * 8 + 2], rh = rd[r * 8 + 3];
    if (!check(rw > 0 && rh > 0 && x >= 0 && y >= 0 && x + rw <= w && y + rh <= h,
               `master ${m} rect out of bbox`)) break;
  }
}
check(maxR === manifest.maxRectsPerMaster, 'manifest maxRectsPerMaster');
// masters.bin doubles as an RGBA32I texture: 2 texels per master, 2 per rect
check(masterCount * 2 <= F.RECT_TEX_WIDTH * 2048, 'master table fits its texture');
check(rectCount * 2 <= F.RECT_TEX_WIDTH * 2048, 'rect table fits its texture');
console.log(`masters.bin ${masterCount.toLocaleString()} masters ` +
            `(${klass[0]} std / ${klass[1]} macro / ${klass[2]} power), ` +
            `${rectCount.toLocaleString()} rects, ${minR}..${maxR} per master, ` +
            `${Math.ceil(rectCount * 2 / F.RECT_TEX_WIDTH)} texture rows`);

const rot = o => o === 2 || o === 3 || o === 6 || o === 7;
const orientedW = (m, o) => (rot(o) ? md[m * 8 + 3] : md[m * 8 + 2]);
const orientedH = (m, o) => (rot(o) ? md[m * 8 + 2] : md[m * 8 + 3]);

// ---------------------------------------------------------------- tiles
const KIND_ID = { deep: F.TILE_KIND.DEEP, mid: F.TILE_KIND.MID, far: F.TILE_KIND.FAR };
// Caps are data, not a constant: the viewer must use exactly these or deep
// tiles draw wrong. Check they are sane and cover the library.
const caps = manifest.bucketCaps;
check(Array.isArray(caps) && caps.length > 0, 'manifest has bucketCaps');
check(caps.every((c, i) => i === 0 || c > caps[i - 1]), 'bucketCaps strictly ascending');
check(caps[caps.length - 1] >= manifest.maxRectsPerMaster, 'last cap covers the largest master');

let totalTiles = 0, totalBytes = 0;

// Shared per-tile checks, used for grid tiles and for overflow lists alike.
function checkTile(buf, lvl, kindId, tag, tx, ty, isOverflow) {
  const u32 = new Uint32Array(buf, 0, 16);
  const i32 = new Int32Array(buf, 0, 16);
  const dv = new DataView(buf);

  check(u32[0] === F.MAGIC_TILE, tag + ' magic');
  check(dv.getUint16(4, true) === F.VERSION, tag + ' version');
  check(dv.getUint16(6, true) === kindId, tag + ' kind');
  check(dv.getUint8(8) === lvl.z, tag + ' z');
  check(u32[14] === tx && u32[15] === ty, tag + ' coords');

  const S = isOverflow ? manifest.world.size : lvl.tileSize;
  check(i32[6] === S, tag + ' tileSize');
  if (isOverflow) check(i32[4] === 0 && i32[5] === 0, tag + ' overflow origin');
  else check(i32[4] === tx * S && i32[5] === ty * S, tag + ' origin');

  const count = u32[3], bucketCount = dv.getUint16(10, true);
  const bucketsOff = u32[12], dataOff = u32[13];
  const recBytes = F.RECORD_BYTES[kindId];
  check(bucketsOff === F.T_HEADER_BYTES, tag + ' bucketsOff');
  check(dataOff === bucketsOff + bucketCount * F.BUCKET_BYTES, tag + ' dataOff');
  check(dataOff % 4 === 0, tag + ' dataOff 4-aligned');
  check(dataOff + count * recBytes === buf.byteLength, tag + ' size exact');
  check(count > 0, tag + ' non-empty');

  let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;
  let rects = 0, placements = 0;
  // Anything this big must have been promoted to the overflow list instead.
  const oversizeLimit = F.OVERSIZE_FRAC * lvl.tileSize;

  if (kindId === F.TILE_KIND.FAR) {
    check(bucketCount === 0, tag + ' far tile has no buckets');
    const bi = new Int32Array(buf, dataOff, count * 8);
    const bf = new Float32Array(buf, dataOff, count * 8);
    for (let k = 0; k < count; k++) {
      const x = bi[k * 8], y = bi[k * 8 + 1], w = bi[k * 8 + 2], h = bi[k * 8 + 3];
      const d = bf[k * 8 + 4], layer = bi[k * 8 + 5], bk = bi[k * 8 + 6];
      check(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= S && y + h <= S, tag + ' block not clipped');
      check(d > 0 && d <= 1.0001, tag + ' block density');
      check(layer >= 12 && layer <= 14, tag + ' block layer');
      check(bk >= 0 && bk <= 2, tag + ' block kind');
      cMinX = Math.min(cMinX, x); cMinY = Math.min(cMinY, y);
      cMaxX = Math.max(cMaxX, x + w); cMaxY = Math.max(cMaxY, y + h);
    }
    rects = count;
  } else {
    const inst = new Int32Array(buf, dataOff, count * 3);
    placements = count;

    if (kindId === F.TILE_KIND.DEEP) {
      const bt = new Uint32Array(buf, bucketsOff, bucketCount * 4);
      let cursor = 0, prev = -1;
      for (let g = 0; g < bucketCount; g++) {
        const b = bt[g * 4], st = bt[g * 4 + 1], c = bt[g * 4 + 2], r = bt[g * 4 + 3];
        check(b > prev && b < caps.length, tag + ' bucket order/range');
        check(st === cursor && c > 0, tag + ' bucket contiguous');
        let sum = 0;
        for (let k = st; k < st + c; k++) {
          const m = inst[k * 3 + 2] & 0xffff;
          const rc = md[m * 8 + 1];
          if (!check(F.bucketOf(rc, caps) === b, tag + ' placement in wrong bucket')) break;
          check(rc <= caps[b], tag + ' rect count exceeds bucket cap');
          sum += rc;
        }
        check(sum === r, tag + ' bucket rectCount');
        prev = b; cursor += c; rects += r;
      }
      check(cursor === count, tag + ' buckets cover all placements');
    } else {
      check(bucketCount === 0, tag + ' mid tile has no buckets');
      rects = count;
    }

    for (let k = 0; k < count; k++) {
      const x = inst[k * 3], y = inst[k * 3 + 1];
      const m = inst[k * 3 + 2] & 0xffff, o = (inst[k * 3 + 2] >>> 16) & 0xff;
      if (!check(m < masterCount, tag + ' master range')) break;
      check(o <= 7, tag + ' bad orient');
      check(x >= 0 && y >= 0 && x < S && y < S, tag + ' placement outside tile');
      const big = Math.max(md[m * 8 + 2], md[m * 8 + 3]) > oversizeLimit;
      check(isOverflow ? big : !big,
            tag + (isOverflow ? ' undersized placement in overflow' : ' oversized placement not promoted'));
      cMinX = Math.min(cMinX, x); cMinY = Math.min(cMinY, y);
      cMaxX = Math.max(cMaxX, x + orientedW(m, o));
      cMaxY = Math.max(cMaxY, y + orientedH(m, o));
    }
  }

  check(u32[7] === rects, tag + ' header rectCount');
  check(i32[8] === cMinX && i32[9] === cMinY && i32[10] === cMaxX && i32[11] === cMaxY,
        tag + ' content box');
  return { placements, rects, bytes: buf.byteLength, bucketCount };
}

for (const lvl of manifest.levels) {
  const side = lvl.tilesPerSide;
  const cov = Buffer.from(lvl.coverage, 'base64');
  check(cov.length === Math.ceil(side * side / 8), `z${lvl.z} coverage length`);
  const present = i => (cov[i >> 3] >> (i & 7)) & 1;

  let nPresent = 0;
  for (let i = 0; i < side * side; i++) if (present(i)) nPresent++;
  check(nPresent === lvl.tileCount, `z${lvl.z} coverage count ${nPresent} vs ${lvl.tileCount}`);

  let checked = 0, levelCount = 0, levelRects = 0, levelBytes = 0, maxB = 0;
  const kindId = KIND_ID[lvl.kind];

  // the level's overflow list, if it has one
  const ovfPath = path.join(DIR, 'tiles', String(lvl.z), 'overflow.bin');
  const ovfExists = fs.existsSync(ovfPath);
  check(ovfExists === !!lvl.overflow, `z${lvl.z} overflow.bin presence vs manifest`);
  if (ovfExists && lvl.overflow) {
    const r = checkTile(read(ovfPath), lvl, kindId, `${lvl.z}/overflow`, F.OVERFLOW_XY, F.OVERFLOW_XY, true);
    check(r.placements === lvl.overflow.count, `z${lvl.z} overflow count`);
    check(r.rects === lvl.overflow.rectCount, `z${lvl.z} overflow rectCount`);
    levelCount += r.placements; levelRects += r.rects; levelBytes += r.bytes;
  }

  for (let i = 0; i < side * side; i++) {
    const tx = i % side, ty = (i / side) | 0;
    const p = path.join(DIR, 'tiles', String(lvl.z), String(tx), `${ty}.bin`);
    const exists = fs.existsSync(p);
    if (!check(exists === !!present(i), `z${lvl.z}/${tx}/${ty} coverage bit vs file`)) continue;
    if (!exists) continue;

    const r = checkTile(read(p), lvl, kindId, `${lvl.z}/${tx}/${ty}`, tx, ty, false);
    levelCount += r.placements; levelRects += r.rects; levelBytes += r.bytes;
    if (r.bucketCount > maxB) maxB = r.bucketCount;
    totalTiles++; totalBytes += r.bytes;
    if (++checked >= SAMPLE) break;
  }

  // Tiles plus overflow are a complete copy of the placement list, at every
  // deep and mid level. Nothing is lost to promotion.
  const full = checked >= lvl.tileCount;
  if (full && kindId !== F.TILE_KIND.FAR)
    check(levelCount === manifest.instanceCount,
          `z${lvl.z} holds ${levelCount} placements, expected ${manifest.instanceCount}`);
  if (full) check(levelRects === lvl.rectTotal, `z${lvl.z} rectTotal ${levelRects} vs ${lvl.rectTotal}`);
  if (full) check(maxB === lvl.maxBuckets, `z${lvl.z} maxBuckets`);

  console.log(`z${String(lvl.z).padStart(2)} ${lvl.kind.padEnd(4)} ` +
    `${String(checked).padStart(6)}/${String(lvl.tileCount).padEnd(6)} tiles  ` +
    `${(levelBytes / 1048576).toFixed(1).padStart(7)} MB  ` +
    `${levelRects.toLocaleString().padStart(12)} rects` +
    (kindId !== F.TILE_KIND.FAR ? `  ${levelCount.toLocaleString()} placements` : '') +
    (lvl.overflow ? `  +${lvl.overflow.count} overflow` : ''));
}

console.log(`total       ${totalTiles.toLocaleString()} tiles, ${(totalBytes / 1048576).toFixed(1)} MB`);

// ---------------------------------------------------------------- lod ladder
//
// The switch points shipped in the manifest are derived from the level table;
// the viewer re-derives them from the same fields, in its own copy of the rule
// (src/lod.js). Two implementations of one rule drift, so this checks that the
// viewer's copy reproduces the shipped ladder exactly, and that the ladder
// keeps the promises it is made of: ordered by z, inside the rectangle budget,
// inside the tile rail.
import('../src/lod.js').then(LOD => {
  const lod = manifest.lod;
  check(!!lod, 'manifest has a lod block');
  if (!lod) return;
  const ref = LOD.deriveLadder(manifest, lod.refView.w, lod.refView.h, lod.maxVisibleTiles);
  check(ref.length === lod.switchPoints.length, 'ladder length matches level count');

  let prev = -Infinity;
  for (let i = 0; i < ref.length; i++) {
    const a = ref[i], b = lod.switchPoints[i];
    const L = manifest.levels[i];
    check(a.z === b.z, `ladder z${a.z} order`);
    check(a.bound === b.bound, `ladder z${a.z} binding constraint ${a.bound} vs ${b.bound}`);
    // Compared at the precision the manifest ships, so this catches drift
    // between the two derivations and nothing else.
    const shipped = Number.isFinite(a.minScale) ? +a.minScale.toPrecision(6) : null;
    check(shipped === b.minScale,
          `ladder z${a.z} switch scale ${shipped} vs shipped ${b.minScale}`);
    check(a.minScale >= prev, `ladder z${a.z} not monotone in z`);
    prev = a.minScale;

    if (a.minScale > 0 && Number.isFinite(a.minScale)) {
      const t = LOD.tilesOnScreen(lod.refView.w, lod.refView.h, L.tileSize, a.minScale);
      const r = t * L.rectP95PerTile + (L.overflow ? L.overflow.rectCount : 0);
      check(r <= manifest.rectBudget * 1.0001,
            `z${a.z} would draw ${Math.round(r)} rects at its own switch scale, budget ${manifest.rectBudget}`);
      check(t <= lod.maxVisibleTiles * 1.0001,
            `z${a.z} would need ${t.toFixed(1)} tiles at its own switch scale, rail ${lod.maxVisibleTiles}`);
    }
    check(L.tileCount === 0 || L.rectP95PerTile > 0, `z${a.z} has a rect p95`);
  }
  check(lod.hysteresis > 1.16, `hysteresis ${lod.hysteresis} must exceed one wheel notch (1.16x)`);

  const shadowed = ref.filter((p, i) => ref[i + 1] && ref[i + 1].minScale <= p.minScale).map(p => p.z);
  console.log(`lod         ${ref.map(p => 'z' + p.z + ' ' + p.minScale.toExponential(2)).join('  ')}` +
              `  hysteresis ${lod.hysteresis}x` +
              (shadowed.length ? `  (never selected: z${shadowed.join(', z')})` : ''));
}).catch(e => {
  check(false, 'lod ladder: ' + e.message);
}).finally(() => {
  console.log(fails === 0 ? 'OK' : `${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
});
