#!/usr/bin/env node
'use strict';
// Write lazy tiles to disk ahead of time.
//
//   node tools/materialise.js [dataDir] [--level Z] [--region x0,y0,x1,y1] [--all]
//
// The tile server produces these on request and there is normally no reason to
// run this. It exists for three:
//
//   - proving byte-identity. Materialise everything a lazy design would produce
//     and compare it with what full generation writes; if the two ever differ,
//     lazy and eager tiles are not interchangeable and the whole scheme is off.
//   - warming a region before a review, so the first person to open the link
//     does not pay for it.
//   - measuring. It reports what each tile cost to produce. --dry-run produces
//     without writing, which is the honest latency number: the write is the
//     cache's cost, not production's. --every N samples one tile in N.
//
// Regions are given in tile coordinates at the level, not nanometres, because
// that is what the caller has when it is warming what a viewer just asked for.

const fs = require('fs');
const path = require('path');
const { TileFactory } = require('./lazy.js');

function parse(argv) {
  const o = { dir: 'data', level: null, region: null, all: false, quiet: false,
              dryRun: false, every: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--level') o.level = +argv[++i];
    else if (a === '--region') o.region = argv[++i].split(',').map(Number);
    else if (a === '--all') o.all = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--every') o.every = Math.max(1, +argv[++i]);
    else if (!a.startsWith('--')) o.dir = a;
    else { console.error(`unknown flag ${a}`); process.exit(1); }
  }
  return o;
}

function main() {
  const o = parse(process.argv.slice(2));
  const dir = path.resolve(o.dir);
  const f = new TileFactory(dir);
  const lazyLevels = f.manifest.levels.filter(L => L.lazy);
  if (!lazyLevels.length) {
    console.log(`${o.dir} has no lazy levels - everything is already on disk`);
    return;
  }

  const levels = o.level === null ? lazyLevels : lazyLevels.filter(L => L.z === o.level);
  if (!levels.length) { console.error(`z${o.level} is not a lazy level`); process.exit(1); }

  const t0 = Date.now();
  let written = 0, bytes = 0;
  const times = [];
  for (const L of levels) {
    const side = L.tilesPerSide;
    const [x0, y0, x1, y1] = o.region || [0, 0, side - 1, side - 1];
    let seen = 0;
    for (let Y = Math.max(0, y0); Y <= Math.min(side - 1, y1); Y++) {
      for (let X = Math.max(0, x0); X <= Math.min(side - 1, x1); X++) {
        if (!f.exists(L.z, X, Y)) continue;
        if (seen++ % o.every !== 0) continue;
        const t = process.hrtime.bigint();
        const buf = f.build(L.z, X, Y);
        times.push(Number(process.hrtime.bigint() - t) / 1e6);
        if (!buf) continue;
        bytes += buf.length;
        written++;
        if (o.dryRun) continue;
        const d = path.join(dir, 'tiles', String(L.z), String(X));
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, `${Y}.bin`), buf);
      }
    }
    if (!o.quiet) {
      console.log(`  z${L.z} ${L.kind}  ${written.toLocaleString()} tiles, ` +
                  `${(bytes / 1048576).toFixed(1)} MB so far`);
    }
  }
  times.sort((a, b) => a - b);
  const at = q => times.length ? times[Math.min(times.length - 1, Math.floor(times.length * q))] : 0;
  console.log(`${o.dryRun ? 'produced' : 'materialised'} ${written.toLocaleString()} tiles, ` +
              `${(bytes / 1048576).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)}s  |  ` +
              `${(bytes / written / 1024).toFixed(1)} KB each  |  produce p50 ${at(0.5).toFixed(3)}ms ` +
              `p90 ${at(0.9).toFixed(3)}ms p99 ${at(0.99).toFixed(3)}ms max ${at(1).toFixed(3)}ms`);
}

main();
