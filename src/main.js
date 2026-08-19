// Manhattan viewer.
//
// The full pyramid with three LOD representations - deep (master internals),
// mid (one outline per placement), far (merged density blocks). Viewport
// culling at tile granularity, prioritised on-demand fetching, persistent GPU
// slot buffers, LRU eviction against a byte budget.
//
// Nothing in the frame path waits on the network. refresh() asks the store for
// what the camera justifies and immediately draws whatever has already
// arrived; tiles fold in as they land.
//
// The level comes from the zoom, on the same basis the generator used to build
// the levels - rectangle budget and cell pixel coverage - with hysteresis so it
// does not flicker on a boundary. See src/lod.js. [ and ] still force a level
// by hand for debugging, and l returns to automatic.

import { viewMasters, KIND_NAME, key, overflowKey } from './format.js';
import { Camera, attachControls } from './camera.js';
import { Renderer, LAYER_NAMES, TOGGLE_LAYERS, CLASS_LAYER_NAMES } from './renderer.js';
import { TileStore, PRIORITY } from './tiles.js';
import { deriveLadder, LevelPicker, viewOf } from './lod.js';
import { Chip, singleInstance, rectToBlock } from './chip.js';

const params = new URLSearchParams(location.search);
const DATA = params.get('data') || '../data';
const CACHE_MB = +(params.get('cache') || 64);
let maxVisibleTiles = +(params.get('maxtiles') || 128);   // manifest default applied at boot
const PREFETCH_RING = +(params.get('ring') ?? 1);

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const gl = canvas.getContext('webgl2', { antialias: false, depth: true });
if (!gl) {
  document.body.innerHTML = '<p style="color:#c66;font:14px monospace;padding:2em">WebGL2 not available.</p>';
  throw new Error('no webgl2');
}

const cam = new Camera();
let manifest = null, store = null, renderer = null, chip = null, view = null;
let levelByZ = new Map();
let wantZ = 0, useZ = 0, clamped = false;
let ladder = null, picker = null, auto = true, chipNote = '';
let visibleKeys = [], instanceDraws = [], lastCandidates = 0, uniqueTiles = 0;
let status = 'loading...';

let levelZs = [];                       // levels that exist, ascending
const levelOf = z => levelByZ.get(z);

// The pyramid can have gaps: the generator does not write a level that no zoom
// could ever select, so z is not a dense range. Everything that moves between
// levels moves through the list of the ones that exist.
function nearestZ(z) {
  let best = levelZs[0];
  for (const v of levelZs) if (v <= z) best = v;
  return best;
}
function stepZ(z, dir) {
  const i = levelZs.indexOf(nearestZ(z)) + dir;
  return levelZs[Math.min(levelZs.length - 1, Math.max(0, i))];
}

function resize() {
  cam.dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * cam.dpr);
  const h = Math.round(canvas.clientHeight * cam.dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const changed = cam.resW !== w || cam.resH !== h;
  cam.resW = w; cam.resH = h;
  if (changed && manifest) buildLadder();
}

// Switch points depend on the viewport - rectangles on screen scale with its
// area - so they are re-solved whenever the canvas changes size, not read from
// a table. The level currently on screen is carried across, so a resize does
// not itself cause a switch.
function buildLadder() {
  const z = picker ? picker.z : null;   // null on the first build: let the cold-start rule decide
  view = viewOf(cam.resW, cam.resH, maxVisibleTiles, chip);
  ladder = deriveLadder(manifest, view);
  picker = new LevelPicker(ladder, manifest.lod.hysteresis);
  picker.seed(z);
}

// Tile range covering `b` - a rect already in block coordinates - expanded by
// `margin` tiles and by the level's content bleed. Overflow promotion is what
// keeps that bleed to one standard cell rather than one macro.
function tileRange(z, b, margin) {
  const L = levelOf(z);
  const S = L.tileSize, over = L.maxOverhang || 0;
  return {
    x0: Math.max(0, Math.floor((b.minX - over) / S) - margin),
    x1: Math.min(L.tilesPerSide - 1, Math.floor(b.maxX / S) + margin),
    y0: Math.max(0, Math.floor((b.minY - over) / S) - margin),
    y1: Math.min(L.tilesPerSide - 1, Math.floor(b.maxY / S) + margin),
  };
}

function candidates(z, b, margin = 0) {
  const r = tileRange(z, b, margin);
  const out = [];
  for (let y = r.y0; y <= r.y1; y++)
    for (let x = r.x0; x <= r.x1; x++)
      if (store.exists(z, x, y)) out.push([x, y]);
  return out;
}

// What the camera justifies, per block instance. The viewport is transformed
// into each instance's own block space - a rect stays a rect under all eight
// orientations - and the tile range is then the same calculation it always was,
// inside the one pyramid every instance shares.
function instanceCandidates(z, margin = 0) {
  const b = cam.bounds();
  const out = [];
  let total = 0;
  for (const inst of chip.visible(b)) {
    const list = candidates(z, rectToBlock(inst.T, b), margin);
    if (!list.length) continue;
    total += list.length;
    out.push({ inst, list });
  }
  return { out, total };
}

// Level from the zoom, then stepped coarser until the tile count is sane. The
// ladder already refuses a level that would need more than maxVisibleTiles at
// this zoom, so the loop is a rail against a level whose coverage is denser
// than the ladder's rectangular estimate, not the usual path.
function resolveLevel() {
  if (auto) wantZ = picker.pick(cam.scale);
  let z = nearestZ(Math.min(wantZ, manifest.maxZ));
  let r = instanceCandidates(z);
  clamped = false;
  while (z > levelZs[0] && r.total > maxVisibleTiles) {
    z = stepZ(z, -1); r = instanceCandidates(z); clamped = true;
  }
  return { z, r };
}

// Tell the store what the camera justifies, in priority order: the visible set
// nearest the centre first, then a ring of neighbours. Then draw whatever has
// already arrived. No awaiting anywhere on this path.
//
// A tile wanted by several block instances is requested ONCE - the key is
// (z, x, y) inside the block, so the cache, the queue and the eviction list all
// dedupe it for free. That is the whole payoff of instancing the block: 70
// copies of a block cost one copy of its tiles.
function refresh() {
  if (!renderer) return;
  const { z, r } = resolveLevel();
  useZ = z;
  lastCandidates = r.total;
  const L = levelOf(z);
  const S = L.tileSize;

  const want = new Map();
  const push = (k, url, priority, dist) => {
    const prev = want.get(k);
    if (prev) {
      if (priority < prev.priority) { prev.priority = priority; prev.dist = dist; }
      else if (priority === prev.priority && dist < prev.dist) prev.dist = dist;
      return;
    }
    want.set(k, { key: k, url, priority, dist });
  };

  const ovf = L.overflow ? overflowKey(z) : null;
  if (ovf) push(ovf, store.overflowUrl(z), PRIORITY.VISIBLE, -1);

  const inside = new Set();
  instanceDraws = [];
  for (const { inst, list } of r.out) {
    const keys = new Set();
    if (ovf) keys.add(ovf);                    // the level's overflow draws with every instance
    for (const [x, y] of list) {
      const k = key(z, x, y);
      keys.add(k);
      inside.add(k);
      // Priority is distance in CHIP space: what is near the eye, not what is
      // near the middle of some block.
      const bx = (x + 0.5) * S, by = (y + 0.5) * S;
      const dx = inst.T.toChipX(bx, by) - cam.x, dy = inst.T.toChipY(bx, by) - cam.y;
      push(k, store.urlFor(z, x, y), PRIORITY.VISIBLE, Math.hypot(dx, dy));
    }
    instanceDraws.push({ inst, keys });
  }
  visibleKeys = [...inside];
  uniqueTiles = inside.size;

  if (PREFETCH_RING > 0) {
    for (const { inst, list } of instanceCandidates(z, PREFETCH_RING).out) {
      for (const [x, y] of list) {
        const k = key(z, x, y);
        if (inside.has(k)) continue;
        const bx = (x + 0.5) * S, by = (y + 0.5) * S;
        const dx = inst.T.toChipX(bx, by) - cam.x, dy = inst.T.toChipY(bx, by) - cam.y;
        push(k, store.urlFor(z, x, y), PRIORITY.PREFETCH, Math.hypot(dx, dy));
      }
    }
  }

  store.request([...want.values()]);
  apply();
}

// Hand the renderer everything that has actually arrived, and the transforms to
// draw it under. Cheap to repeat: setVisible reconciles, so unchanged tiles cost
// nothing.
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
  const draws = instanceDraws.map(({ inst, keys }) => ({
    m: inst.T.m, tx: inst.T.tx, ty: inst.T.ty, keys,
  }));
  renderer.setVisible(wanted, cam, draws);
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

  // The chip beside the block, if there is one. A viewer pointed at a bare
  // block runs as a chip of one instance at the origin, so there is one path
  // through everything below rather than two.
  chip = singleInstance(manifest);
  const chipUrl = params.get('chip') || `${DATA}/chip.json`;
  try {
    const res = await fetch(chipUrl);
    if (res.ok) {
      const doc = await res.json();
      const single = doc.instances.filter(i => (i.block | 0) === 0);
      if (single.length !== doc.instances.length) {
        chipNote = `${doc.instances.length - single.length} instances of other blocks ignored`;
      }
      chip = new Chip({ ...doc, instances: single }, manifest.world.size);
    }
  } catch (e) { chipNote = 'chip.json: ' + e.message; }
  store = new TileStore(DATA, manifest, CACHE_MB);
  store.onTile = k => { if (k === overflowKey(useZ) || visibleKeys.includes(k)) scheduleApply(); };
  levelByZ = new Map(manifest.levels.map(l => [l.z, l]));
  levelZs = manifest.levels.map(l => l.z).sort((a, b) => a - b);
  maxVisibleTiles = +(params.get('maxtiles') || manifest.lod.maxVisibleTiles);
  buildLadder();

  const masters = viewMasters(await (await fetch(`${DATA}/masters.bin`)).arrayBuffer());
  renderer = new Renderer(gl, masters, manifest.bucketCaps);
  renderer.densityRange = manifest.densityRange || [0, 1];
  renderer.blockSize = manifest.world.size;
  renderer.blockBounds = chip.count > 1;

  cam.fit(0, 0, chip.w, chip.h);
  // A partial pyramid (--one-tile) has no ladder to walk: only one level holds
  // tiles at all, so automatic choice would pick an empty one.
  auto = !manifest.partial && params.get('auto') !== '0';
  if (params.has('z')) { wantZ = nearestZ(+params.get('z')); auto = false; }
  else if (!auto) wantZ = manifest.maxZ;
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
  if (params.has('alpha')) setTranslucent(renderer, +params.get('alpha') !== 0);
  if (params.has('solo')) solo(renderer, +params.get('solo'));
  if (params.has('blocks')) renderer.blockBounds = +params.get('blocks') !== 0;

  refresh();
  await store.settle();      // only so scripted runs are deterministic
  apply();
  status = `ready in ${(performance.now() - t0).toFixed(0)}ms`;

  const nPan = +(params.get('pan') || 0);
  if (nPan > 0) await runPan(nPan);
  const nFling = +(params.get('fling') || 0);
  if (nFling > 0) await runFling(nFling);
  if (params.has('sweep')) await runSweep();
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
    if (cam.x > chip.w - L.tileSize) { cam.x = L.tileSize; cam.y += step; }
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
    if (cam.x > chip.w - L.tileSize) { cam.x = L.tileSize; cam.y += step; }
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

// Scripted LOD sweep: where the level actually switches, and what is on screen
// either side of each switch.
//
// Pass one walks the zoom range through the real selector - not a copy of its
// arithmetic - in both directions, because hysteresis puts the switch-in and
// switch-out scales in different places, and records every change. Pass two
// parks the camera at each of those scales, forces the level the selector would
// have chosen on each side, and reads the rectangle count the renderer actually
// holds. The estimate the ladder was solved from is printed beside it, so the
// two are directly comparable.
const SWEEP_POS = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]];

async function runSweep() {
  const H = manifest.lod.hysteresis;
  const fit = Math.min(cam.resW / chip.w, cam.resH / chip.h);
  const lo = fit / 2, hi = ladder[ladder.length - 1].minScale * H * 3;

  const walk = (from, to, step) => {
    const p = new LevelPicker(ladder, H);
    const out = [];
    let z = p.pick(from);
    for (let s = from; step > 1 ? s <= to : s >= to; s *= step) {
      const nz = p.pick(s);
      if (nz !== z) { out.push({ from: z, to: nz, scale: s }); z = nz; }
    }
    return out;
  };

  // Worst of a few camera positions: cell density varies across the die, and
  // the budget is a ceiling, not an average.
  const measure = async (z, scale) => {
    auto = false; wantZ = z; cam.scale = scale;
    let rects = 0, tiles = 0, at = z, cl = false, insts = 0, uniq = 0;
    for (const [fx, fy] of SWEEP_POS) {
      cam.x = chip.w * fx; cam.y = chip.h * fy;
      refresh();
      await store.settle();
      apply();
      if (clamped) cl = true;
      at = useZ;
      if (renderer.rectCount * instanceDraws.length > rects * Math.max(1, insts)) {
        rects = renderer.rectCount; tiles = lastCandidates;
        insts = instanceDraws.length; uniq = uniqueTiles;
      }
    }
    return { rects, tiles, clamped: cl, at, insts, uniq };
  };

  // rects is what one block's resident set holds; the chip draws it once per
  // visible instance, so the on-screen figure is that times the instances.
  const side = (z, scale, m) =>
    `z${z} ${levelOf(z).kind} ${fmt(m.rects * m.insts)} rects = ${fmt(m.rects)} x ${m.insts} blocks, ` +
    `${m.tiles} tile draws from ${m.uniq} fetched ` +
    `(est ${fmt(Math.round(picker.estimate(z, view, scale)))})` +
    (m.at !== z ? ` CLAMPED to z${m.at}` : '');

  report(`lod sweep  ${cam.resW}x${cam.resH} canvas dpr ${cam.dpr}, budget ${fmt(manifest.rectBudget)} rects, ` +
         `hysteresis ${H}x, maxtiles ${maxVisibleTiles}, worst of ${SWEEP_POS.length} camera positions, ` +
         `chip ${chip.count} block instances (${chip.nx}x${chip.ny})`);
  report('  ladder   ' + ladder.map(p =>
    `z${p.z} ${p.minScale.toExponential(3)} (${p.bound})`).join('  |  '));

  const runs = [
    ['zoom in ', walk(lo, hi, 1.005)],
    ['zoom out', walk(hi, lo, 1 / 1.005)],
  ];
  for (const [dir, list] of runs) {
    if (!list.length) report(`  ${dir}  no switches in ${lo.toExponential(2)}..${hi.toExponential(2)}`);
    for (const t of list) {
      const sA = t.scale / 1.002, sB = t.scale * 1.002;
      const a = await measure(t.from, sA);
      const b = await measure(t.to, sB);
      report(`  ${dir}  z${t.from}->z${t.to} at ${t.scale.toExponential(3)} px/nm ` +
             `(${(1 / t.scale).toFixed(0)} nm/px, cell ${(manifest.meanCellWidth * t.scale).toFixed(2)} px)  |  ` +
             `before ${side(t.from, sA, a)}  |  after ${side(t.to, sB, b)}`);
    }
  }

  auto = true;
  picker.seed(useZ);
  status = `lod sweep done: ${runs[0][1].length} switches zooming in, ${runs[1][1].length} zooming out`;
  report('  ' + status);
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
// Alpha for the translucent path. Everything a process engineer wants to see
// through is routing: metal over via over metal. The lower layers stay nearly
// opaque so the cell still reads as a cell.
const ALPHA_PRESET = [1, 1, 0.85, 0.85, 0.8, 0.55, 0.6, 0.5, 0.45, 0.7, 0.9, 0.5, 1, 1, 1, 1];

function setTranslucent(R, on) {
  R.translucent = on;
  for (let i = 0; i < 16; i++) R.layerAlpha[i] = on ? ALPHA_PRESET[i] : 1;
}

// Solo: show one layer, hide the rest. Toggling eight layers off to look at one
// is the thing nobody does twice, so it is one keystroke - shift and the layer's
// own number. Shift-clicking the soloed layer again restores what was visible
// before it, not "everything": coming back to a working set matters.
let soloLayer = -1, maskBeforeSolo = 0xffff;

function solo(R, layer) {
  if (soloLayer === layer) {
    R.layerMask = maskBeforeSolo;
    soloLayer = -1;
    return;
  }
  if (soloLayer === -1) maskBeforeSolo = R.layerMask;
  R.layerMask = 1 << layer;
  soloLayer = layer;
}

window.addEventListener('keydown', e => {
  if (!renderer) return;
  const R = renderer;
  // e.code, not e.key: shift turns '1' into '!' and the layer keys have to keep
  // working with it held.
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    const layer = TOGGLE_LAYERS[+digit[1] - 1];
    if (e.shiftKey) solo(R, layer);
    else { R.layerMask ^= 1 << layer; soloLayer = -1; }
    return;
  }
  switch (e.key) {
    case 'a': R.layerMask = R.layerMask === 0xffff ? 0 : 0xffff; soloLayer = -1; break;
    case 'v': setTranslucent(R, !R.translucent); break;
    case 'b': R.blockBounds = !R.blockBounds; break;
    case 'c': R.colorMode ^= 1; break;
    case 't': R.showTiles = !R.showTiles; break;
    case 'p': R.minPx = R.minPx > 0 ? 0 : 1; break;
    case 'r': R.updateWorstMs = 0; break;
    case '-': store.budgetMB = Math.max(4, store.budgetMB / 2); break;
    case '=': case '+': store.budgetMB = store.budgetMB * 2; break;
    case ']': auto = false; wantZ = stepZ(useZ, +1); refresh(); break;
    case '[': auto = false; wantZ = stepZ(useZ, -1); refresh(); break;
    case 'l': auto = !auto; picker.seed(useZ); refresh(); break;
    case 'f': cam.fit(0, 0, chip.w, chip.h); refresh(); break;
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

// The whole ladder, current level bracketed: switch-out scale per level, so a
// glance says how far the camera is from the next switch in either direction.
function ladderLine() {
  return ladder.map(p => {
    const v = p.minScale > 0 ? p.minScale.toExponential(1) : '0';
    return p.z === useZ ? `[z${p.z} ${v}]` : ` z${p.z} ${v} `;
  }).join('');
}

function layerLine(R) {
  return TOGGLE_LAYERS.map((l, i) => {
    const on = (R.layerMask >> l) & 1;
    const a = R.translucent && R.layerAlpha[l] < 1 ? `(${R.layerAlpha[l].toFixed(2)})` : '';
    return `${on ? '+' : '-'}${i + 1}:${LAYER_NAMES[l]}${a}`;
  }).join(' ');
}

function drawHud(dt) {
  const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
  const s = store.stats;
  const L = levelOf(useZ);
  const R = renderer;
  const budget = manifest.rectBudget;
  const band = picker.band(useZ);
  const bound = (ladder.find(p => p.z === useZ) || {}).bound;
  const est = picker.estimate(useZ, view, cam.scale);
  const nmPerPx = 1 / cam.scale;
  const reqs = s.loaded + s.hits;
  hud.textContent =
`LOD        z ${useZ} / ${manifest.maxZ}   ${KIND_NAME[R.kind]}   tile ${(L.tileSize / 1000).toFixed(1)}um   bleed ${(L.maxOverhang / 1000).toFixed(1)}um   ${auto ? 'auto' : 'MANUAL'}` +
  `${clamped ? `   (clamped from z${wantZ})` : ''}
ladder     ${ladderLine()}   holds >= ${band[0].toExponential(2)}, switches in at ${band[1].toExponential(2)} (${bound})   est ${fmt(Math.round(est))} rects
chip       ${fmt(R.instances.length)} / ${fmt(chip.count)} block instances on screen   draws ${fmt(R.drawCalls)}   ${chipNote}
tiles      resident ${fmt(R.resident.size)}/${fmt(uniqueTiles)} unique, ${fmt(lastCandidates)} drawn${L.overflow ? ` +ovf ${fmt(L.overflow.count)}` : ''}   inflight ${fmt(store.active)}  queued ${fmt(store.queue.length)}  loaded ${fmt(s.loaded)}  hit ${reqs ? (100 * s.hits / reqs).toFixed(0) : 0}%
cache      ${mb(store.bytes)} / ${store.budgetMB.toFixed(0)} MB  (pinned ${mb(store.pinnedBytes)})   evicted ${fmt(s.evicted)} = ${mb(s.evictedBytes)} MB   aborted ${fmt(s.aborted)}  dropped ${fmt(s.dropped)}
placements ${fmt(R.instanceCount * R.instances.length)}   rects ${fmt(R.rectCount * R.instances.length)} / ${fmt(budget)} (${(100 * R.rectCount * R.instances.length / budget).toFixed(0)}%)   submitted ${fmt(R.submittedRects)} (+${(100 * (R.submittedRects / Math.max(1, R.rectCount) - 1)).toFixed(0)}% bucket pad)
masters    ${fmt(R.distinctMasters)} distinct of ${fmt(R.masters.masterCount)} in library   draws ${fmt(R.drawCalls)}   buckets [${R.caps.join(',')}]
update     last ${R.updateMs.toFixed(2)} ms (+${R.lastAdded}/-${R.lastRemoved} tiles)   worst ${R.updateWorstMs.toFixed(2)} ms   count ${fmt(R.updates)}   slot waste ${(100 * R.waste).toFixed(0)}%
frame      ${dt.toFixed(2)} ms  (submit ${submitMs.toFixed(2)} ms)   fps(60) ${(1000 / avg).toFixed(1)}
memory     masters ${mb(R.masters.bytes)} MB   gpu slots ${mb(R.poolBytes)} MB
zoom       ${cam.scale.toExponential(2)} px/nm   ${nmPerPx < 1 ? (nmPerPx * 1000).toFixed(1) + ' pm/px' : nmPerPx.toFixed(1) + ' nm/px'}   origin ${R.originX.toFixed(0)},${R.originY.toFixed(0)}
layers     ${layerLine(R)}   ${soloLayer >= 0 ? `SOLO ${LAYER_NAMES[soloLayer]}` : '(+ visible, - hidden)'}
color      ${R.colorMode ? `by class: ${CLASS_LAYER_NAMES.join(' / ')}` : 'by layer'}   ${R.translucent ? 'translucent (layer passes)' : 'opaque'}   density ${(100 * R.densityRange[0]).toFixed(0)}-${(100 * R.densityRange[1]).toFixed(0)}%   tiles ${R.showTiles ? 'on' : 'off'}   blocks ${R.blockBounds ? 'on' : 'off'}   minPx ${R.minPx.toFixed(1)}   ring ${PREFETCH_RING}
keys       drag pan, wheel zoom, l auto/manual level, [ ] level by hand, f fit, 1-9 layer, shift+1-9 solo, a all, c colour, v translucent, b blocks, t tiles, p subpixel, r reset, -/= cache
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
