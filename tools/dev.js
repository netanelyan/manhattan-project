#!/usr/bin/env node
'use strict';
// The developer workflow, in one place.
//
//   node tools/dev.js <target> [--count N] [--blocks N] [--seed S] [--port P] [--data DIR]
//
// The Makefile and the npm scripts are both thin wrappers around this. That is
// deliberate: two copies of "how do I regenerate and serve this" is two things
// to keep in step, and Windows without make still needs every target to work.
//
// Core Node only, forward slashes everywhere, no shell built-ins - it runs the
// same from Git Bash, cmd.exe, and Linux.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = f => path.join(__dirname, f);

const DEFAULTS = { count: '5m', blocks: '70', seed: '42', port: '8080', data: 'data' };

function parse(argv) {
  const o = { ...DEFAULTS, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([a-z-]+)$/.exec(a);
    if (m && Object.prototype.hasOwnProperty.call(o, m[1])) o[m[1]] = argv[++i];
    else o.rest.push(a);
  }
  return o;
}

function run(args, opts) {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) process.exit(r.status === null ? 1 : r.status);
  return r;
}

// What the current data/ was generated from. Regenerating 1.2 GB because
// somebody typed `serve` is exactly the surprise this avoids; changing --count
// or --blocks is exactly the case where the data really is stale.
const stampPath = o => path.join(ROOT, o.data, '.gen-params');
const stampFor = o => `--count ${o.count} --blocks ${o.blocks} --seed ${o.seed}`;

function genArgs(o) {
  return [TOOL('gen.js'), '--count', o.count, '--blocks', o.blocks,
          '--seed', o.seed, '--out', o.data, ...o.rest];
}

function gen(o) {
  run(genArgs(o));                       // gen.js verifies what it wrote
  fs.writeFileSync(stampPath(o), stampFor(o) + '\n');
}

// Returns true if it generated.
function ensure(o) {
  const manifest = path.join(ROOT, o.data, 'manifest.json');
  if (!fs.existsSync(manifest)) {
    console.log(`${o.data}/ is empty - generating`);
    gen(o);
    return true;
  }
  let stamp = '';
  try { stamp = fs.readFileSync(stampPath(o), 'utf8').trim(); } catch { stamp = ''; }
  if (stamp !== stampFor(o)) {
    console.log(`${o.data}/ was built with [${stamp || 'unknown parameters'}], want [${stampFor(o)}] - regenerating`);
    gen(o);
    return true;
  }
  console.log(`${o.data}/ is current [${stamp}] - skipping generation (make gen to force)`);
  return false;
}

const TARGETS = {
  help: {
    doc: 'list targets',
    run: () => {
      const width = Math.max(...Object.keys(TARGETS).map(k => k.length));
      console.log('manhattan\n');
      for (const [name, t] of Object.entries(TARGETS)) {
        console.log('  ' + name.padEnd(width + 2) + t.doc);
      }
      console.log(`\nparameters (make gen COUNT=20m BLOCKS=9, or npm run gen -- --count 20m --blocks 9):`);
      for (const [k, v] of Object.entries(DEFAULTS)) console.log(`  --${k.padEnd(8)} ${v}`);
    },
  },
  dev: {
    doc: 'generate if needed, verify, serve  (the one to run)',
    run: o => { if (!ensure(o)) verify(o); serve(o); },
  },
  gen: { doc: 'generate data/, always', run: o => gen(o) },
  big: { doc: 'generate at 50m x 70 blocks - the scale test', run: o => gen({ ...o, count: '50m', blocks: '70' }) },
  block: { doc: 'generate a single block, no chip level', run: o => gen({ ...o, blocks: '1' }) },
  verify: { doc: 'check data/ against every invariant', run: o => verify(o) },
  check: {
    doc: 'drive the viewer in a headless browser and fail on an empty frame',
    run: o => run([TOOL('check.js'), '--data', o.data, '--port', String(+o.port + 40)]),
  },
  serve: { doc: 'serve the viewer, no regeneration', run: o => serve(o) },
  bench: { doc: 'time the visible-set update outside the browser', run: o => run([TOOL('bench.js'), o.data]) },
  clean: {
    doc: 'remove data/',
    run: o => {
      fs.rmSync(path.resolve(ROOT, o.data), { recursive: true, force: true });
      console.log(`removed ${o.data}/`);
    },
  },
};

function verify(o) { run([TOOL('verify.js'), o.data]); }
function serve(o) {
  console.log(`\nviewer  http://localhost:${o.port}/src/`);
  run([TOOL('serve.js'), o.port]);
}

const opts = parse(process.argv.slice(3));
const name = process.argv[2] || 'help';
const target = TARGETS[name];
if (!target) {
  console.error(`unknown target ${name}`);
  TARGETS.help.run(opts);
  process.exit(1);
}
target.run(opts);
