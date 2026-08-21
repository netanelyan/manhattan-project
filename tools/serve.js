#!/usr/bin/env node
'use strict';
// Static file server for the repo root. ES modules and fetch() need a real
// origin; file:// will not do. Core Node only.
//
//   node tools/serve.js [port] [--data DIR] [--host H] [--no-jobs] [--cache-mb N]
//
// MANY DESIGNS, ONE SERVER. Nothing here is bound to a single data directory:
// the root is served whole, and lazy tile production keys off the directory in
// the request path, so any number of generated or imported pyramids can sit
// side by side. Which one the viewer opens is `?data=` in the URL, and that is
// the mechanism rather than a convenience - a link that names the design as
// well as the camera position is what a review comment actually needs.
//
// `--data DIR` is for the local case: it checks the directory is really a
// design, says what is in it, and prints the URL with `?data=` already on it so
// there is nothing to remember. It changes no routing.
//
// IMPORT AND GENERATE FROM THE BROWSER. /__designs lists what is on disk;
// /__upload takes a LEF/DEF a file at a time; /__import and /__generate shell
// out to tools/import-def.js and tools/gen.js and stream their stdout back.
// There is no second parser and no second writer - the browser path saves
// typing, and the tiling stays the offline job it has to be, because an 89 GB
// DEF is not something a tab is ever going to hold.
//
// Because those routes start processes, the server binds to 127.0.0.1 unless
// --host says otherwise, and --no-jobs turns them off entirely.
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
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
let PORT = 8080, CACHE_MB = 0, DATA = '', HOST = '127.0.0.1', JOBS = true;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cache-mb') CACHE_MB = +argv[++i];
  else if (argv[i] === '--data') DATA = argv[++i];
  else if (argv[i] === '--host') HOST = argv[++i];
  else if (argv[i] === '--no-jobs') JOBS = false;
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

// ---------------------------------------------------------------- designs
//
// A design is a directory with a manifest in it. Nothing is registered and
// nothing is configured: the list is whatever is on disk, so an import that
// finished a second ago is in it.
const DESIGN_CACHE = new Map();       // dir -> { mtimeMs, entry }

function dirBytes(dir) {
  let total = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* raced with a write */ } }
    }
  };
  try { walk(dir); } catch { return 0; }
  return total;
}

function designEntry(name) {
  const dir = path.join(ROOT, name);
  const mf = path.join(dir, 'manifest.json');
  let st;
  try { st = fs.statSync(mf); } catch { return null; }
  const hit = DESIGN_CACHE.get(name);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.entry;
  let m;
  try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { return null; }
  const p = m.provenance || null;
  const entry = {
    name,
    source: m.source || 'synthetic',
    placements: m.instanceCount,
    masters: m.masterCount,
    dieW: m.die.w, dieH: m.die.h,
    levels: m.levels.map(L => ({ z: L.z, kind: L.kind, tiles: L.tileCount, lazy: !!L.lazy })),
    lazy: m.levels.some(L => L.lazy),
    bytes: dirBytes(dir),
    // The one thing about a design that the picture cannot tell you, carried
    // through to the picker so the choice is made with it in view.
    synthesizedPlacement: !!(p && /^synthesized/.test(p.placement || '')),
    from: p ? p.dir : null,
  };
  DESIGN_CACHE.set(name, { mtimeMs: st.mtimeMs, entry });
  return entry;
}

function designList() {
  const out = [];
  for (const name of designs()) {
    const e = designEntry(name);
    if (e) out.push(e);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------- jobs
//
// Tiling is an offline job and stays one: this shells out to the same
// tools/import-def.js and tools/gen.js the CLI runs, and streams their stdout
// back line by line. There is no second parser and no second writer - the point
// of the browser path is to save typing, not to become a pipeline.
//
// One job at a time, deliberately. Two imports writing tiles at once would be
// two processes competing for the same disk for no benefit, and a queue would
// be a scheduler nobody asked for.
const UPLOAD_MAX = 256 * 1024 * 1024;        // per file
const UPLOAD_TOTAL_MAX = 600 * 1024 * 1024;  // per job
const JOB_RE = /^[A-Za-z0-9_-]{8,64}$/;
const OUT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

let running = null;                   // { kind, child, out }
const uploads = new Map();            // job -> { dir, bytes, files: [] }

function uploadDir(job) {
  let u = uploads.get(job);
  if (!u) {
    u = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'manhattan-up-')), bytes: 0, files: [] };
    uploads.set(job, u);
  }
  return u;
}

function dropUpload(job) {
  const u = uploads.get(job);
  if (!u) return;
  try { fs.rmSync(u.dir, { recursive: true, force: true }); } catch { /* gone already */ }
  uploads.delete(job);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Resolve the output directory, refusing anything that is not a single safe
// name under the root, and refusing to write over a design that is already
// there unless it was asked for explicitly.
function resolveOut(name, overwrite) {
  if (!OUT_RE.test(name || '')) {
    return { err: `"${name}" is not a directory name: letters, digits, dot, dash and underscore, no separators` };
  }
  const dir = path.join(ROOT, name);
  if (!dir.startsWith(ROOT + path.sep)) return { err: 'outside the served root' };
  const existing = designEntry(name);
  if (existing && !overwrite) {
    return { err: `${name}/ already holds a ${existing.source} design ` +
                  `(${existing.placements.toLocaleString()} placements). Tick overwrite, or pick another name.` };
  }
  return { dir, name };
}

// Run a tool and stream its output to the response as it arrives. The last line
// is always a sentinel, so the client never has to guess whether a silent
// stream means "working" or "died".
function runJob(res, kind, args, onDone) {
  if (running) {
    res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
       .end(`busy: a ${running.kind} is already running\n__fail 409\n`);
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  const child = spawn(process.execPath, args, { cwd: ROOT });
  running = { kind, child };
  console.log(`${kind}  ${args.slice(1).join(' ')}`);
  const pipe = s => {
    let tail = '';
    s.on('data', d => {
      tail += d.toString();
      const lines = tail.split('\n');
      tail = lines.pop();
      for (const l of lines) res.write(l + '\n');
    });
    s.on('end', () => { if (tail) res.write(tail + '\n'); });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('close', code => {
    running = null;
    let extra = '';
    try { extra = onDone ? (onDone(code) || '') : ''; } catch (e) { extra = String(e.message); }
    if (extra) res.write(extra + '\n');
    res.end(code === 0 ? '__done\n' : `__fail ${code}\n`);
  });
  child.on('error', e => {
    running = null;
    res.end(`could not start: ${e.message}\n__fail 1\n`);
  });
  // A closed tab should not leave a tiler running against the disk.
  res.on('close', () => {
    if (running && running.child === child && !child.killed) {
      child.kill();
      console.log(`${kind}  client went away, killed`);
    }
  });
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
  // Every design on disk, for the viewer's picker.
  if (rel === '/__designs') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
       .end(JSON.stringify({ designs: designList(), jobs: JOBS, root: path.basename(ROOT) }));
    return;
  }

  if (rel === '/__upload' || rel === '/__import' || rel === '/__generate') {
    if (!JOBS) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
         .end('import and generate are disabled (--no-jobs)\n__fail 403\n');
      return;
    }
    handleJobRoute(rel, req, res).catch(e => {
      try { res.end(`${e.message}\n__fail 1\n`); } catch { /* already gone */ }
    });
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
}).listen(PORT, HOST, () => announce());

// ---------------------------------------------------------------- job routes
async function handleJobRoute(rel, req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const bad = (code, msg) => res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
                                .end(msg + `\n__fail ${code}\n`);
  if (req.method !== 'POST') return bad(405, 'POST only');

  // --- one file of an upload, raw. Multipart would mean a parser; this way the
  // client sends one request per file and the body IS the file.
  if (rel === '/__upload') {
    const job = q.get('job'), name = path.basename(q.get('name') || '');
    if (!JOB_RE.test(job || '')) return bad(400, 'bad job id');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return bad(400, `bad file name "${name}"`);
    const u = uploadDir(job);
    let body;
    try { body = await readBody(req, UPLOAD_MAX); }
    catch {
      dropUpload(job);
      return bad(413, `${name} is over the ${(UPLOAD_MAX / 1048576) | 0} MB per-file limit`);
    }
    if (u.bytes + body.length > UPLOAD_TOTAL_MAX) {
      dropUpload(job);
      return bad(413, `over the ${(UPLOAD_TOTAL_MAX / 1048576) | 0} MB total limit for one import`);
    }
    fs.writeFileSync(path.join(u.dir, name), body);
    u.bytes += body.length;
    u.files.push(name);
    res.writeHead(200, { 'content-type': 'application/json' })
       .end(JSON.stringify({ ok: true, name, bytes: body.length, total: u.bytes }));
    return;
  }

  const raw = await readBody(req, 1 << 20);
  let o;
  try { o = JSON.parse(raw.toString('utf8') || '{}'); } catch { return bad(400, 'bad JSON'); }

  // --- import: the uploaded LEF/DEF, through the same tool the CLI runs
  if (rel === '/__import') {
    const job = o.job;
    if (!JOB_RE.test(job || '')) return bad(400, 'bad job id');
    const u = uploads.get(job);
    if (!u) return bad(400, 'no files were uploaded for this job');
    const missing = ['cells.lef', 'tech.lef', 'floorplan.def'].filter(f => !u.files.includes(f));
    if (missing.length) {
      dropUpload(job);
      return bad(400, `missing ${missing.join(', ')} - an import needs cells.lef, tech.lef and floorplan.def`);
    }
    const out = resolveOut(o.out, o.overwrite);
    if (out.err) { dropUpload(job); return bad(400, out.err); }

    const args = [path.join(__dirname, 'import-def.js'), '--dir', u.dir, '--out', out.name];
    if (o.place) args.push('--place', 'rows');
    if (o.noOutline) args.push('--no-outline');
    if (o.perTile) args.push('--per-tile', String(o.perTile));
    if (o.lazy) args.push('--lazy');
    runJob(res, 'import', args, code => {
      dropUpload(job);
      DESIGN_CACHE.delete(out.name);
      // Exit 2 is import-def.js saying the DEF has no placement in it. That is
      // the single most likely way a real benchmark fails here, and it has a
      // remedy, so it is spelled out rather than left as a number.
      if (code === 2) {
        return '\nThis DEF is a floorplan: its COMPONENTS are UNPLACED, so there are no\n' +
               'coordinates to tile. Tick "place into the DEF rows" and import again -\n' +
               'that fills the design\'s own rows and records in the manifest that it did.';
      }
      return code === 0 ? `\nopen it:  ?data=${out.name}` : '';
    });
    return;
  }

  // --- generate: the synthetic design, same flags as the CLI
  if (rel === '/__generate') {
    const out = resolveOut(o.out, o.overwrite);
    if (out.err) return bad(400, out.err);
    const args = [path.join(__dirname, 'gen.js'), '--out', out.name];
    if (o.count) args.push('--count', String(o.count));
    if (o.blocks) args.push('--blocks', String(o.blocks));
    if (o.seed !== undefined && o.seed !== '') args.push('--seed', String(o.seed));
    if (o.orient) args.push('--block-orient', String(o.orient));
    if (o.lazy) args.push('--lazy');
    runJob(res, 'generate', args, code => {
      DESIGN_CACHE.delete(out.name);
      return code === 0 ? `\nopen it:  ?data=${out.name}` : '';
    });
    return;
  }

  return bad(404, 'no such route');
}

// ---------------------------------------------------------------- startup
//
// What a data directory turns out to be, for the line printed at startup. A
// design is a directory with a manifest in it; anything else named by --data is
// a typo worth catching before the browser reports it as a 404.
function describe(dir) {
  const rel = dir.replace(/^[/\\]+|[/\\]+$/g, '');
  const file = path.join(ROOT, rel, 'manifest.json');
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const um = v => (v / 1000).toFixed(1);
    const p = m.provenance;
    return {
      rel,
      line: `${m.source || 'synthetic'}, ${m.instanceCount.toLocaleString()} placements, ` +
            `${m.masterCount.toLocaleString()} masters, ${um(m.die.w)} x ${um(m.die.h)} um` +
            (p ? `, from ${p.dir}` : ''),
      warn: p && /^synthesized/.test(p.placement || '')
        ? `placement synthesized, not read from the DEF - see manifest.provenance` : '',
    };
  } catch {
    return { rel, line: null };
  }
}

// Every design sitting under the root, so the startup line says what is
// available rather than only what was asked for.
function designs() {
  const out = [];
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (fs.existsSync(path.join(ROOT, e.name, 'manifest.json'))) out.push(e.name);
  }
  return out;
}

function announce() {
  const found = designs();
  console.log(`serving ${ROOT}`);
  if (DATA) {
    const d = describe(DATA);
    if (d.line === null) {
      console.log(`  --data ${d.rel}: no manifest.json there, so it is not a design`);
      if (found.length) console.log(`         designs under the root: ${found.join(', ')}`);
    } else {
      console.log(`  design  ${d.rel}  ${d.line}`);
      if (d.warn) console.log(`          ${d.warn}`);
    }
    // ?data= is what actually selects it, so the flag prints the URL that does
    // rather than implying the server is bound to one design.
    console.log(`  viewer  http://localhost:${PORT}/src/?data=${d.rel}`);
  } else {
    console.log(`  viewer  http://localhost:${PORT}/src/`);
  }
  const others = found.filter(n => n !== (DATA || 'data').replace(/^[/\\]+|[/\\]+$/g, ''));
  if (others.length) {
    console.log(`  also    ${others.map(n => `?data=${n}`).join('  ')}`);
  }
  console.log(`  designs ${found.length} on disk; the viewer lists them with o` +
              (JOBS ? ', and imports and generates through this server' : ' (jobs disabled)'));
  if (JOBS && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`  NOTE    bound to ${HOST}, and /__import runs the tiler on this machine.` +
                ` Use --no-jobs on a shared network.`);
  }
}


