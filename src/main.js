// Manhattan viewer.
//
// The full pyramid with three LOD representations - deep (master internals),
// mid (one outline per placement), far (merged density blocks). Viewport
// culling at tile granularity, prioritised on-demand fetching, persistent GPU
// slot buffers, LRU eviction against a byte budget.
//
// Nothing in the frame path waits on the network. refresh() asks the store for
// what the camera justifies and immediately draws whatever has already
// arrived; tiles fold in as they land. Level choice is still manual ([ and ]);
// picking it from zoom is step 4.

import { viewMasters, KIND_NAME, key, overflowKey } from './format.js';
import { Camera, attachControls } from './camera.js';
import { Renderer, LAYER_NAMES, TOGGLE_LAYERS } from './renderer.js';
import { TileStore, PRIORITY } from './tiles.js';

const params = new URLSearchParams(location.search);
const DATA = params.get('data') || '../data';
const CACHE_MB = +(params.get('cache') || 64);
const MAX_VISIBLE_TILES = +(params.get('maxtiles') || 128);
const PREFETCH_RING = +(params.get('ring') ?? 1);

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const gl = canvas.getContext('webgl2', { antialias: false, depth: true });
if (!gl) {
  document.body.innerHTML = '<p style="color:#c66;font:14px monospace;padding:2em">WebGL2 not available.</p>';
  throw new Error('no webgl2');
}

const cam = new Camera();
let manifest = null, store = null, renderer = null;
let levelByZ = new Map();
let wantZ = 0, useZ = 0, clamped = false;
let visibleKeys = [], lastCandidates = 0;
let status = 'loading...';

const levelOf = z => levelByZ.get(z);

function resize() {
  cam.dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * cam.dpr);
  const h = Math.round(canvas.clientHeight * cam.dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  cam.resW = w; cam.resH = h;
}

// Tile range covering the viewport, expanded by `margin` tiles and by the
// level's content bleed. Overflow promotion is what keeps that bleed to one
// standard cell rather than one macro.
function tileRange(z, margin) {
  const L = levelOf(z);
  const b = cam.bounds();
  const S = L.tileSize, over = L.maxOverhang || 0;
  return {
    x0: Math.max(0, Math.floor((b.minX - over) / S) - margin),
    x1: Math.min(L.tilesPerSide - 1, Math.floor(b.maxX / S) + margin),
    y0: Math.max(0, Math.floor((b.minY - over) / S) - margin),
    y1: Math.min(L.tilesPerSide - 1, Math.floor(b.maxY / S) + margin),
  };
}

function candidates(z, margin = 0) {
  const r = tileRange(z, margin);
  const out = [];
  for (let y = r.y0; y <= r.y1; y++)
    for (let x = r.x0; x <= r.x1; x++)
      if (store.exists(z, x, y)) out.push([x, y]);
  return out;
}

// Requested level, stepped coarser until the tile count is sane.
function resolveLevel() {
  let z = Math.min(wantZ, manifest.maxZ);
  let c = candidates(z);
  clamped = false;
  while (z > 0 && c.length > MAX_VISIBLE_TILES) { z--; c = candidates(z); clamped = true; }
  return { z, c };
}

// Tell the store what the camera justifies, in priority order: the visible set
// nearest the centre first, then a ring of neighbours. Then draw whatever has
// already arrived. No awaiting anywhere on this path.
function refresh() {
  if (!renderer) return;
  const { z, c } = resolveLevel();
  useZ = z;
  lastCandidates = c.length;
  const L = levelOf(z);
  const S = L.tileSize;

  const want = [];
  if (L.overflow) {
    want.push({ key: overflowKey(z), url: store.overflowUrl(z), priority: PRIORITY.VISIBLE, dist: -1 });
  }

  const inside = new Set();
  for (const [x, y] of c) {
    const k = key(z, x, y);
    inside.add(k);
    const dx = (x + 0.5) * S - cam.x, dy = (y + 0.5) * S - cam.y;
    want.push({ key: k, url: store.urlFor(z, x, y), priority: PRIORITY.VISIBLE, dist: Math.hypot(dx, dy) });
  }
  visibleKeys = [...inside];

  if (PREFETCH_RING > 0) {
    for (const [x, y] of candidates(z, PREFETCH_RING)) {
      const k = key(z, x, y);
      if (inside.has(k)) continue;
      const dx = (x + 0.5) * S - cam.x, dy = (y + 0.5) * S - cam.y;
      want.push({ key: k, url: store.urlFor(z, x, y), priority: PRIORITY.PREFETCH, dist: Math.hypot(dx, dy) });
    }
  }

  store.request(want);
  apply();
}

// Hand the renderer everything that has actually arrived. Cheap to repeat:
// setVisible reconciles, so unchanged tiles cost nothing.
function apply() {
  const L = levelOf(useZ);
  const wanted = new Map();
  if (L.overflow) {
    const o = store.get(overflowKey(useZ));
    if (o) wanted.set(overflowKey(useZ), o);
  }
  for (const k of visibleKeys) {
    const t = store.get(k);
    if (t) wanted.set(k, t);
  }
  renderer.setVisible(wanted, cam);
  store.setPinned(new Set(wanted.keys()));
  store.evict();
}

let applyQueued = false;
function scheduleApply() {
  if (applyQueued) return;
  applyQueued = true;
  requestAnimationFrame(() => { applyQueued = false; apply(); });
}

async function boot() {
  resize();
  const t0 = performance.now();
  manifest = await (await fetch(`${DATA}/manifest.json`)).json();
  store = new TileStore(DATA, manifest, CACHE_MB);
  store.onTile = k => { if (k === overflowKey(useZ) || visibleKeys.includes(k)) scheduleApply(); };
  levelByZ = new Map(manifest.levels.map(l => [l.z, l]));

  const masters = viewMasters(await (await fetch(`${DATA}/masters.bin`)).arrayBuffer());
  renderer = new Renderer(gl, masters, manifest.bucketCaps);

  cam.fit(0, 0, manifest.die.w, manifest.die.h);
  wantZ = +(params.get('z') ?? 0);
  const v = params.get('view');
  if (v) {
    const [cx, cy, sc] = v.split(',').map(Number);
    if (Number.isFinite(cx)) cam.x = cx;
    if (Number.isFinite(cy)) cam.y = cy;
    if (Number.isFinite(sc)) cam.scale = sc;
  }
  if (params.has('tiles')) renderer.showTiles = true;
  if (params.has('mask')) renderer.layerMask = parseInt(params.get('mask'), 0);
  if (params.has('color')) renderer.colorMode = +params.get('color') ? 1 : 0;
  if (params.has('minpx')) renderer.minPx = +params.get('minpx');

  refresh();
  await store.settle();      // only so scripted runs are deterministic
  apply();
  status = `ready in ${(performance.now() - t0).toFixed(0)}ms`;

  const nPan = +(params.get('pan') || 0);
  if (nPan > 0) await runPan(nPan);
  const nFling = +(params.get('fling') || 0);
  if (nFling > 0) await runFling(nFling);
  requestAnimationFrame(frame);
}

// Pan across tile boundaries and record what each visible-set change costs.
// Everything is cached after the first crossing, so this isolates the CPU
// update from the network.
async function runPan(steps) {
  const L = levelOf(useZ);
  const step = L.tileSize * 0.45;
  const samples = [];
  let maxAdded = 0;
  renderer.updateWorstMs = 0;
  for (let i = 0; i < steps; i++) {
    cam.x += step;
    if (cam.x > manifest.world.size - L.tileSize) { cam.x = L.tileSize; cam.y += step; }
    // Sample both applies: with a prefetch ring the tiles are usually already
    // cached, so the update lands in refresh()'s apply, not the one after
    // settle. Take the larger of the two.
    let worst = 0, added = 0;
    let before = renderer.updates;
    refresh();
    if (renderer.updates > before) { worst = renderer.updateMs; added = renderer.lastAdded; }
    before = renderer.updates;
    await store.settle();
    apply();
    if (renderer.updates > before && renderer.updateMs > worst) {
      worst = renderer.updateMs; added = Math.max(added, renderer.lastAdded);
    }
    if (added > 0) {
      samples.push(worst);
      if (added > maxAdded) maxAdded = added;
    }
  }
  samples.sort((a, b) => a - b);
  const n = samples.length;
  const avg = n ? samples.reduce((a, b) => a + b, 0) / n : 0;
  const s = store.stats;
  status = `pan z${useZ} ${L.kind} ${steps} steps, ${n} updates, ` +
    `${renderer.resident.size} tiles resident, ${fmt(renderer.instanceCount)} placements, ` +
    `up to ${maxAdded} added per update | update ` +
    `min ${(samples[0] || 0).toFixed(2)} med ${(samples[n >> 1] || 0).toFixed(2)} ` +
    `avg ${avg.toFixed(2)} max ${(samples[n - 1] || 0).toFixed(2)} ms | ` +
    `cache ${mb(store.bytes)}/${store.budgetMB.toFixed(0)}MB loaded ${s.loaded} hits ${s.hits} ` +
    `evicted ${s.evicted} aborted ${s.aborted} dropped ${s.dropped}`;
  await report(status);
}

// Camera outrunning the network: move faster than tiles can arrive, without
// settling, so requests are superseded. Proves that stale work is dropped from
// the queue or aborted in flight rather than being fetched and thrown away.
async function runFling(steps) {
  const L = levelOf(useZ);
  const step = L.tileSize * 1.7;
  const before = { ...store.stats };
  for (let i = 0; i < steps; i++) {
    cam.x += step;
    if (cam.x > manifest.world.size - L.tileSize) { cam.x = L.tileSize; cam.y += step; }
    refresh();
  }
  await store.settle();
  apply();
  const s = store.stats;
  status = `fling z${useZ} ${L.kind} ${steps} jumps of ${(step / 1000).toFixed(0)}um | ` +
    `queued-then-dropped ${s.dropped - before.dropped}, aborted in flight ${s.aborted - before.aborted}, ` +
    `actually loaded ${s.loaded - before.loaded} | resident ${renderer.resident.size}, ` +
    `cache ${mb(store.bytes)}/${store.budgetMB.toFixed(0)}MB, evicted ${s.evicted - before.evicted}`;
  await report(status);
}

// Awaited, not fire-and-forget: the page's load event waits for it, so a
// scripted run cannot screenshot and exit before the numbers are delivered.
// (was sendBeacon page teardown; a plain fetch races the screenshot and
// loses often enough to make scripted runs unreliable.
function report(msg) {
  const url = '/__log?msg=' + encodeURIComponent(msg);
  if (!(navigator.sendBeacon && navigator.sendBeacon(url))) fetch(url).catch(() => {});
}

let refreshQueued = false;
function onCameraChange() {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => { refreshQueued = false; refresh(); });
}

attachControls(canvas, cam, onCameraChange);
window.addEventListener('resize', () => { resize(); onCameraChange(); });
window.addEventListener('keydown', e => {
  if (!renderer) return;
  const R = renderer;
  if (e.key >= '1' && e.key <= '9') R.layerMask ^= 1 << TOGGLE_LAYERS[+e.key - 1];
  switch (e.key) {
    case 'a': R.layerMask = R.layerMask === 0xffff ? 0 : 0xffff; break;
    case 'c': R.colorMode ^= 1; break;
    case 't': R.showTiles = !R.showTiles; break;
    case 'p': R.minPx = R.minPx > 0 ? 0 : 1; break;
    case 'r': R.updateWorstMs = 0; break;
    case '-': store.budgetMB = Math.max(4, store.budgetMB / 2); break;
    case '=': case '+': store.budgetMB = store.budgetMB * 2; break;
    case ']': wantZ = Math.min(manifest.maxZ, wantZ + 1); refresh(); break;
    case '[': wantZ = Math.max(0, wantZ - 1); refresh(); break;
    case 'f': cam.fit(0, 0, manifest.die.w, manifest.die.h); refresh(); break;
  }
});

// ---------------------------------------------------------------- loop
const dts = [];
let lastT = 0, submitMs = 0;

function frame(t) {
  resize();
  const dt = lastT ? t - lastT : 16.7;
  lastT = t;
  dts.push(dt);
  if (dts.length > 60) dts.shift();

  const d0 = performance.now();
  renderer.draw(cam);
  submitMs = performance.now() - d0;

  drawHud(dt);
  requestAnimationFrame(frame);
}

const fmt = n => n.toLocaleString('en-US');
const mb = b => (b / 1048576).toFixed(2);

function layerLine(R) {
  return TOGGLE_LAYERS.map((l, i) =>
    `${(R.layerMask >> l) & 1 ? '+' : '-'}${i + 1}:${LAYER_NAMES[l]}`).join(' ');
}

function drawHud(dt) {
  const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
  const s = store.stats;
  const L = levelOf(useZ);
  const R = renderer;
  const budget = manifest.rectBudget;
  const nmPerPx = 1 / cam.scale;
  const reqs = s.loaded + s.hits;
  hud.textContent =
`LOD        z ${useZ} / ${manifest.maxZ}   ${KIND_NAME[R.kind]}   tile ${(L.tileSize / 1000).toFixed(1)}um   bleed ${(L.maxOverhang / 1000).toFixed(1)}um` +
  `${clamped ? `   (clamped from z${wantZ})` : ''}
tiles      resident ${fmt(R.resident.size)}/${fmt(lastCandidates)}${L.overflow ? ` +ovf ${fmt(L.overflow.count)}` : ''}   inflight ${fmt(store.active)}  queued ${fmt(store.queue.length)}  loaded ${fmt(s.loaded)}  hit ${reqs ? (100 * s.hits / reqs).toFixed(0) : 0}%
cache      ${mb(store.bytes)} / ${store.budgetMB.toFixed(0)} MB  (pinned ${mb(store.pinnedBytes)})   evicted ${fmt(s.evicted)} = ${mb(s.evictedBytes)} MB   aborted ${fmt(s.aborted)}  dropped ${fmt(s.dropped)}
placements ${fmt(R.instanceCount)}   rects ${fmt(R.rectCount)} / ${fmt(budget)} (${(100 * R.rectCount / budget).toFixed(0)}%)   submitted ${fmt(R.submittedRects)} (+${(100 * (R.submittedRects / Math.max(1, R.rectCount) - 1)).toFixed(0)}% bucket pad)
masters    ${fmt(R.distinctMasters)} distinct of ${fmt(R.masters.masterCount)} in library   draws ${fmt(R.drawCalls)}   buckets [${R.caps.join(',')}]
update     last ${R.updateMs.toFixed(2)} ms (+${R.lastAdded}/-${R.lastRemoved} tiles)   worst ${R.updateWorstMs.toFixed(2)} ms   count ${fmt(R.updates)}   slot waste ${(100 * R.waste).toFixed(0)}%
frame      ${dt.toFixed(2)} ms  (submit ${submitMs.toFixed(2)} ms)   fps(60) ${(1000 / avg).toFixed(1)}
memory     masters ${mb(R.masters.bytes)} MB   gpu slots ${mb(R.poolBytes)} MB
zoom       ${cam.scale.toExponential(2)} px/nm   ${nmPerPx < 1 ? (nmPerPx * 1000).toFixed(1) + ' pm/px' : nmPerPx.toFixed(1) + ' nm/px'}   origin ${R.originX.toFixed(0)},${R.originY.toFixed(0)}
layers     ${layerLine(R)}   (+ visible, - hidden)
color      ${R.colorMode ? 'by class' : 'by layer'}   tiles ${R.showTiles ? 'on' : 'off'}   minPx ${R.minPx.toFixed(1)}   ring ${PREFETCH_RING}   multi_draw ${R.multiDraw ? 'available (unused)' : 'unavailable'}
keys       drag pan, wheel zoom, [ ] level, f fit, 1-9 layer, a all, c colour, t tiles, p subpixel, r reset, -/= cache budget
${status}`;
}

// Top-level await, so the page's load event waits for the first tiles. That
// makes scripted screenshots deterministic without a virtual clock - and a
// virtual clock would freeze performance.now() across synchronous work, which
// is exactly the work the update timer needs to measure.
try {
  await boot();
} catch (e) {
  status = String(e);
  hud.textContent = `boot failed: ${e.message}\n\nRun the generator first:\n  node tools/gen.js --count 500k\nthen serve the repo root:\n  node tools/serve.js`;
  console.error(e);
}
