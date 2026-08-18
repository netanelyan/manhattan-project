#!/usr/bin/env node
'use strict';
// Reads the generated binaries back with the same zero-parse view logic the
// viewer uses, and checks every invariant the viewer relies on.
//
//   node tools/verify.js [dataDir]

const fs = require('fs');
const path = require('path');
const F = require('./format.js');

const DIR = path.resolve(process.argv[2] || 'data');
let fails = 0;
function check(ok, msg) {
  if (!ok) { console.error('  FAIL ' + msg); fails++; }
  return ok;
}
const read = p => {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
console.log(`manifest    maxZ ${manifest.maxZ}, ${manifest.instanceCount.toLocaleString()} instances, world ${manifest.world.size}nm`);

// ---- masters.bin
const mbuf = read(path.join(DIR, 'masters.bin'));
const mh = new Uint32Array(mbuf, 0, 8);
check(mh[0] === F.MAGIC_MASTERS, 'masters magic');
const masterCount = mh[2], rectCount = mh[3], mastersOff = mh[4], rectsOff = mh[5];
check(mastersOff % 4 === 0 && rectsOff % 4 === 0, 'masters offsets 4-aligned');
check(masterCount === manifest.masterCount, 'masterCount matches manifest');
check(rectsOff + rectCount * F.RECT_BYTES === mbuf.byteLength, 'masters.bin size exact');

const md = new Int32Array(mbuf, mastersOff, masterCount * 8);
const rd = new Int32Array(mbuf, rectsOff, rectCount * 8);
let minR = 1e9, maxR = 0, sumR = 0, klass = [0, 0, 0];
for (let m = 0; m < masterCount; m++) {
  const s = md[m * 8], c = md[m * 8 + 1], w = md[m * 8 + 2], h = md[m * 8 + 3];
  if (!check(s >= 0 && s + c <= rectCount, `master ${m} rect range`)) break;
  if (!check(w > 0 && h > 0, `master ${m} bbox`)) break;
  klass[md[m * 8 + 4]]++;
  minR = Math.min(minR, c); maxR = Math.max(maxR, c); sumR += c;
  // every rect must sit inside the master bounding box
  for (let r = s; r < s + c; r++) {
    const x = rd[r * 8], y = rd[r * 8 + 1], rw = rd[r * 8 + 2], rh = rd[r * 8 + 3];
    if (!check(rw > 0 && rh > 0 && x >= 0 && y >= 0 && x + rw <= w && y + rh <= h,
               `master ${m} rect ${r - s} out of bbox: ${x},${y} ${rw}x${rh} in ${w}x${h}`)) { r = s + c; m = masterCount; }
  }
}
const texels = rectCount * 2;
check(texels <= F.RECT_TEX_WIDTH * 2048, 'rect table fits the rect texture');
console.log(`masters.bin ${masterCount} masters (${klass[0]} std / ${klass[1]} macro / ${klass[2]} power), ` +
            `${rectCount} rects, ${minR}..${maxR} per master (avg ${(sumR / masterCount).toFixed(1)}), ` +
            `${Math.ceil(texels / F.RECT_TEX_WIDTH)} texture rows`);

// ---- tiles
let tiles = 0, instTotal = 0, rectTotal = 0, bytes = 0;
for (const lvl of manifest.levels) {
  for (const [tx, ty] of lvl.tiles) {
    const p = path.join(DIR, 'tiles', String(lvl.z), String(tx), `${ty}.bin`);
    const buf = read(p);
    const u32 = new Uint32Array(buf, 0, 16);
    const i32 = new Int32Array(buf, 0, 16);
    const dv = new DataView(buf);
    const tag = `${lvl.z}/${tx}/${ty}`;
    check(u32[0] === F.MAGIC_TILE, `${tag} magic`);
    check(dv.getUint16(6, true) === F.TILE_KIND.INSTANCES, `${tag} kind`);
    check(dv.getUint8(8) === lvl.z, `${tag} z`);
    check(u32[14] === tx && u32[15] === ty, `${tag} coords`);
    check(i32[4] === tx * lvl.tileSize && i32[5] === ty * lvl.tileSize, `${tag} origin`);
    check(i32[6] === lvl.tileSize, `${tag} tileSize`);

    const count = u32[3], groupCount = dv.getUint16(10, true);
    const groupsOff = u32[12], dataOff = u32[13];
    check(groupsOff === F.T_HEADER_BYTES, `${tag} groupsOff`);
    check(dataOff === groupsOff + groupCount * F.GROUP_BYTES, `${tag} dataOff`);
    check(dataOff % 4 === 0, `${tag} dataOff 4-aligned`);
    check(dataOff + count * F.INSTANCE_BYTES === buf.byteLength, `${tag} size exact`);

    const groups = new Uint32Array(buf, groupsOff, groupCount * 4);
    const inst = new Int32Array(buf, dataOff, count * 3);

    // groups must partition the instance array, be master-sorted and ascending
    let cursor = 0, prevMaster = -1, rects = 0;
    for (let g = 0; g < groupCount; g++) {
      const m = groups[g * 4], s = groups[g * 4 + 1], c = groups[g * 4 + 2], gr = groups[g * 4 + 3];
      check(m > prevMaster, `${tag} group ${g} master order`);
      check(s === cursor, `${tag} group ${g} contiguous`);
      check(c > 0, `${tag} group ${g} non-empty`);
      check(gr === c * md[m * 8 + 1], `${tag} group ${g} rect count`);
      // every instance in the group must actually carry that master id
      for (let i = s; i < s + c; i++) {
        if (!check((inst[i * 3 + 2] & 0xffff) === m, `${tag} instance ${i} master mismatch`)) { g = groupCount; break; }
      }
      prevMaster = m; cursor += c; rects += gr;
    }
    check(cursor === count, `${tag} groups cover all instances`);
    check(u32[7] === rects, `${tag} header rectCount`);

    // instance coordinates must be tile-local and inside the declared content box
    const minX = i32[8], minY = i32[9], maxX = i32[10], maxY = i32[11];
    let bad = 0, cMinX = 1e18, cMinY = 1e18, cMaxX = -1e18, cMaxY = -1e18;
    for (let i = 0; i < count; i++) {
      const x = inst[i * 3], y = inst[i * 3 + 1];
      const m = inst[i * 3 + 2] & 0xffff, o = (inst[i * 3 + 2] >>> 16) & 0xff;
      if (x < 0 || y < 0 || x >= lvl.tileSize || y >= lvl.tileSize) bad++;
      if (o > 7) bad++;
      const rot = o === 2 || o === 3 || o === 6 || o === 7;
      const w = rot ? md[m * 8 + 3] : md[m * 8 + 2];
      const h = rot ? md[m * 8 + 2] : md[m * 8 + 3];
      if (x < cMinX) cMinX = x;
      if (y < cMinY) cMinY = y;
      if (x + w > cMaxX) cMaxX = x + w;
      if (y + h > cMaxY) cMaxY = y + h;
    }
    check(bad === 0, `${tag} ${bad} instances outside tile or bad orient`);
    check(minX === cMinX && minY === cMinY && maxX === cMaxX && maxY === cMaxY,
          `${tag} content box ${minX},${minY},${maxX},${maxY} vs ${cMinX},${cMinY},${cMaxX},${cMaxY}`);

    tiles++; instTotal += count; rectTotal += rects; bytes += buf.byteLength;
    if (tiles <= 3) console.log(`tile ${tag}   ${count.toLocaleString()} instances, ${groupCount} groups, ${rects.toLocaleString()} rects, ${buf.byteLength.toLocaleString()} bytes`);
  }
}
console.log(`tiles       ${tiles} verified, ${instTotal.toLocaleString()} instances, ${rectTotal.toLocaleString()} rects, ${(bytes / 1048576).toFixed(2)} MB`);
console.log(fails === 0 ? 'OK' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
