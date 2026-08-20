#!/usr/bin/env node
'use strict';
// Benchmarks the CPU work behind a visible-set change - the cost the viewer
// pays when the camera crosses a tile boundary. Runs the viewer's real slot
// builders (src/slots.js) over real tiles, with no renderer competing for CPU.
//
// Also reports the two numbers the draw strategy turns on: how many distinct
// masters a visible set touches, and how many rectangles get submitted once
// bucket padding is counted.
//
//   node tools/bench.js [dataDir] [--tiles N] [--reps N]

const fs = require('fs');
const path = require('path');
const F = require('./format.js');

const args = process.argv.slice(2);
const DIR = path.resolve(args.find(a => !a.startsWith('--')) || 'data');
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? +args[i + 1] : dflt;
};
const TILES = flag('tiles', 48);
const REPS = flag('reps', 30);

function readBuf(p) {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

async function main() {
  const { viewMasters, viewTile, TILE_KIND, I_STRIDE } = await import('../src/format.js');
  const { buildPlacementSlots, buildBlockSlots, tileBuckets,
          PLACEMENT_SLOT_I32, BLOCK_SLOT_I32 } = await import('../src/slots.js');

  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const masters = viewMasters(readBuf(path.join(DIR, 'masters.bin')));
  const caps = manifest.bucketCaps;

  console.log(`visible-set update bench - ${manifest.instanceCount.toLocaleString()} placements, ` +
              `${masters.masterCount.toLocaleString()} masters, buckets [${caps.join(',')}], ` +
              `up to ${TILES} tiles, ${REPS} reps`);
  console.log('  z  kind  tiles   placements       rects   submitted  pad  masters  draws |  full ms  per-tile ms');

  const seen = new Uint8Array(masters.masterCount);
  let scratch = new Int32Array(1 << 16);
  const need = n => { if (scratch.length < n) scratch = new Int32Array(n); return scratch; };

  // A lazily generated design has no deep or mid tiles on disk. Producing them
  // here is the point rather than a workaround: this bench measures the slot
  // builders over real tiles, and a tile off the index is the same tile.
  const factory = manifest.levels.some(L => L.lazy)
    ? new (require('./lazy.js').TileFactory)(DIR) : null;

  for (const lvl of manifest.levels) {
    const side = lvl.tilesPerSide;
    const want = Math.min(TILES, lvl.tileCount);
    const tiles = [];
    outer:
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const p = path.join(DIR, 'tiles', String(lvl.z), String(x), `${y}.bin`);
        if (lvl.lazy && !fs.existsSync(p)) {
          const made = factory.build(lvl.z, x, y);
          if (!made) continue;
          tiles.push(viewTile(made.buffer.slice(made.byteOffset, made.byteOffset + made.byteLength)));
        } else {
          if (!fs.existsSync(p)) continue;
          tiles.push(viewTile(readBuf(p)));
        }
        if (tiles.length >= want) break outer;
      }
    }
    const ovfPath = path.join(DIR, 'tiles', String(lvl.z), 'overflow.bin');
    if (fs.existsSync(ovfPath)) tiles.push(viewTile(readBuf(ovfPath)));
    if (!tiles.length) continue;

    // what the visible set costs the GPU
    seen.fill(0);
    let placements = 0, rects = 0, submitted = 0, distinct = 0;
    for (const t of tiles) {
      placements += t.count;
      rects += t.rectCount;
      if (t.kind === TILE_KIND.FAR) { submitted += t.count; continue; }
      if (t.kind === TILE_KIND.MID) submitted += t.count;
      else for (const b of tileBuckets(t)) submitted += b.count * caps[b.bucket];
      for (let i = 0; i < t.count; i++) {
        const m = t.inst[i * I_STRIDE + 2] & 0xffff;
        if (seen[m] === 0) { seen[m] = 1; distinct++; }
      }
    }
    const deep = tiles[0].kind === TILE_KIND.DEEP;
    const draws = deep ? new Set(tiles.flatMap(t => tileBuckets(t).map(b => b.bucket))).size : 1;

    // building every tile's slots from scratch: the worst a pan can cost
    const samples = [];
    for (let i = 0; i < REPS; i++) {
      const t0 = process.hrtime.bigint();
      for (const t of tiles) {
        if (t.kind === TILE_KIND.FAR) {
          buildBlockSlots(t, 0, need(t.count * BLOCK_SLOT_I32));
        } else if (t.kind === TILE_KIND.MID) {
          buildPlacementSlots(t, 0, t.count, 0, need(t.count * PLACEMENT_SLOT_I32));
        } else {
          for (const b of tileBuckets(t)) {
            buildPlacementSlots(t, b.start, b.count, 0, need(b.count * PLACEMENT_SLOT_I32));
          }
        }
      }
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const med = samples[REPS >> 1];

    console.log(
      `  ${lvl.z}  ${lvl.kind.padEnd(4)}  ${String(tiles.length).padStart(5)}  ` +
      `${placements.toLocaleString().padStart(11)}  ${rects.toLocaleString().padStart(10)}  ` +
      `${submitted.toLocaleString().padStart(10)}  ` +
      `${(100 * (submitted / Math.max(1, rects) - 1)).toFixed(0).padStart(3)}%  ` +
      `${String(distinct).padStart(7)}  ${String(draws).padStart(5)} |  ` +
      `${med.toFixed(2).padStart(6)}  ${(med / tiles.length).toFixed(3).padStart(11)}`);
  }
}

main();
