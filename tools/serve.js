#!/usr/bin/env node
'use strict';
// Static file server for the repo root. ES modules and fetch() need a real
// origin; file:// will not do. Core Node only.
//
//   node tools/serve.js [port] [--cache-mb N]   ->  http://localhost:8080/src/
//
// LAZY TILES. A design generated with --lazy has no deep or mid tiles on disk,
// only the index they are produced from. When a request for one arrives and the
// file is not there, it is built here and served. The viewer is not told and
// does not need to be: it asks for tiles/{z}/{x}/{y}.bin the same way it always
// did, and the coverage bitmap in the manifest still tells it which tiles exist,
// so it never asks for one that cannot be produced.
//
// This is where generation belongs rather than in a background worker or a
// batch CLI, for one reason: the viewer's request IS the demand signal, and it
// already arrives in priority order with a prefetch ring behind it and stale
// requests aborted. Anything else would be a second guess at the same thing.

const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
let PORT = 8080, CACHE_MB = 0;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cache-mb') CACHE_MB = +argv[++i];
  else if (!argv[i].startsWith('--')) PORT = +argv[i];
}
const ROOT = path.resolve(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
};

// ---------------------------------------------------------------- lazy tiles
//
// One factory per data directory, built on first use. It holds the index and
// the master table, which is the whole reason a tile costs microseconds rather
// than a process start.
const factories = new Map();
const stats = { built: 0, ms: 0, bytes: 0, cached: 0, evicted: 0, times: [] };

function factoryFor(dataDir) {
  if (factories.has(dataDir)) return factories.get(dataDir);
  let f = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8'));
    if (manifest.levels.some(L => L.lazy)) {
      const { TileFactory } = require('./lazy.js');
      f = new TileFactory(dataDir);
      const lz = manifest.levels.filter(L => L.lazy).map(L => 'z' + L.z).join(' ');
      console.log(`lazy tiles  ${path.relative(ROOT, dataDir) || '.'}: ${lz} on demand from placements.bin` +
                  `  (disk cache ${CACHE_MB > 0 ? CACHE_MB + ' MB' : 'off'})`);
    }
  } catch { f = null; }               // not a data directory, or not generated yet
  factories.set(dataDir, f);
  return f;
}

// The disk cache is off by default, and that is a measurement, not an oversight:
// producing a tile costs well under a millisecond, which is less than the write
// that would save it. Turning it on re-creates on disk exactly the deep level
// that was not written in the first place, one viewed tile at a time. Bounded
// when it is on, and only ever over what this process wrote - tiles put there
// deliberately by tools/materialise.js are not this cache's to evict.
const written = new Map();            // file -> bytes, in insertion (LRU) order
let writtenBytes = 0;

function cacheTile(file, buf) {
  if (CACHE_MB <= 0) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    written.set(file, buf.length);
    writtenBytes += buf.length;
    stats.cached++;
    const budget = CACHE_MB * 1048576;
    for (const [f, n] of written) {
      if (writtenBytes <= budget) break;
      written.delete(f);
      writtenBytes -= n;
      try { fs.unlinkSync(f); stats.evicted++; } catch { /* already gone */ }
    }
  } catch { /* a cache that cannot write is still a working server */ }
}

const TILE_RE = /^\/(.+)\/tiles\/(\d+)\/(\d+)\/(\d+)\.bin$/;

// Returns the tile bytes, or null if this is not a producible tile.
function produce(rel) {
  const m = TILE_RE.exec(rel);
  if (!m) return null;
  const dataDir = path.join(ROOT, m[1]);
  if (!dataDir.startsWith(ROOT + path.sep)) return null;
  const f = factoryFor(dataDir);
  if (!f) return null;
  const z = +m[2], x = +m[3], y = +m[4];
  if (!f.isLazy(z)) return null;
  const t0 = process.hrtime.bigint();
  const buf = f.build(z, x, y);
  if (!buf) return null;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  stats.built++; stats.ms += ms; stats.bytes += buf.length;
  stats.times.push(ms);
  return buf;
}

http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad url');
    return;
  }
  // Scripted-measurement sink: the viewer's ?bench mode posts its numbers here
  // so a headless run can report them without depending on screenshot timing.
  if (rel === '/__log') {
    console.log(new URL(req.url, 'http://x').searchParams.get('msg') || '');
    res.writeHead(204).end();
    return;
  }
  // What lazy tile production has cost, for a scripted run to read back.
  if (rel === '/__tilestats') {
    const t = stats.times.slice().sort((a, b) => a - b);
    const at = q => (t.length ? t[Math.min(t.length - 1, Math.floor(t.length * q))] : 0);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      built: stats.built, totalMs: +stats.ms.toFixed(1), bytes: stats.bytes,
      p50: +at(0.5).toFixed(3), p90: +at(0.9).toFixed(3), p99: +at(0.99).toFixed(3),
      max: +at(1).toFixed(3), cached: stats.cached, evicted: stats.evicted,
    }));
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // Not on disk. If it is a tile of a lazy level, that is not an error -
      // it is the normal case, and the tile is built now.
      const made = produce(rel);
      if (made) {
        cacheTile(file, made);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-cache',
          'x-tile': 'generated',
        }).end(made);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    }).end(data);
  });
}).listen(PORT, () => {
  console.log(`serving ${ROOT}\n  viewer  http://localhost:${PORT}/src/\n  data    http://localhost:${PORT}/data/manifest.json`);
});
