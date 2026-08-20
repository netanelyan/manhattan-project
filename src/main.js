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
import { pick, KLASS_NAME, ORIENT_NAME } from './pick.js';

const params = new URLSearchParams(location.search);
const DATA = params.get('data') || '../data';
const CACHE_MB = +(params.get('cache') || 64);
let maxVisibleTiles = +(params.get('maxtiles') || 128);   // manifest default applied at boot
const PREFETCH_RING = +(params.get('ring') ?? 1);
const JUMP_CELL_PX = 10;      // arriving at a coordinate should show geometry, not a region

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const notice = document.getElementById('notice');
const help = document.getElementById('help');
const panel = document.getElementById('panel');
const bar = document.getElementById('bar');
const jumpInput = document.getElementById('jump');
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
  // The zoom floor is fit-to-die at the current viewport, so it moves with the
  // window - a narrower canvas fits the die at a lower scale and may legally go
  // further out than the wider one could.
  if (changed && chip) cam.setWorld(chip.w, chip.h);
  if (changed && manifest) buildLadder();
}

// Switch points depend on the viewport - rectangles on screen scale with its
// area - so they are re-solved whenever the canvas changes size, not read from
// a table. The level currently on screen is carried across, so a resize does
// not itself cause a switch.
function buildLadder() {
  const z = picker ? picker.z : null;   // null on the first build: let the cold-start rule decide
  view = viewOf(cam.resW, cam.resH, maxVisibleTiles, chip, cam.minScale);
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
//
// An instance with no tiles under the viewport is still returned. It is not the
// empty case it looks like: a level's oversized features live in its overflow
// list, not in its tiles, so where a macro sits the deep level has no tiles at
// all - the coverage bitmap says so - and the macro itself is in the overflow.
// Dropping the instance there dropped the only thing that had the geometry, and
// zooming into a macro went black. `total` still counts tile draws only, so the
// rail that steps the level coarser is unaffected.
function instanceCandidates(z, margin = 0) {
  const b = cam.bounds();
  const out = [];
  let total = 0;
  for (const inst of chip.visible(b)) {
    const list = candidates(z, rectToBlock(inst.T, b), margin);
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
    // Nothing to draw and nothing always-resident to draw either: skip it
    // rather than spend a draw call proving it. With an overflow list the
    // instance stays, because the overflow is exactly where the geometry that
    // is missing from the tiles has gone.
    if (!list.length && !ovf) continue;
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

  // Pin before requesting, not after drawing. Eviction runs the moment a tile
  // lands - inside the fetch, before the frame that would draw it - and it used
  // to run against the pin set left by the last apply(). At a level change with
  // the cache at its budget that set names the level being left, so tiles the
  // camera had just asked for could be evicted between arriving and being drawn,
  // and had to be fetched again. What the camera justifies is known here, one
  // step earlier, so this is where the residency set is declared.
  //
  // The keys are block-space (z, x, y), so 70 instances of a block name one
  // key: the pin set is per tile, not per instance, and eviction cannot drop a
  // tile that other instances still draw. Prefetch is deliberately not pinned -
  // it is a guess, and a guess should be the first thing evicted.
  store.setPinned(new Set([...inside, ...(ovf ? [ovf] : [])]));
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
  store.evict();
  refreshSelection();
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

  cam.setWorld(chip.w, chip.h);
  buildLadder();                 // re-solved now that the ladder knows the floor
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
  if (params.has('hud')) setHudMode(Math.max(0, HUD_KEYS.indexOf(params.get('hud'))));

  refresh();
  await store.settle();      // only so scripted runs are deterministic
  apply();
  if (params.has('pick')) {
    const [px, py] = params.get('pick').split(',').map(Number);
    if (Number.isFinite(px) && Number.isFinite(py)) identifyAt(px, py);
  }
  writeUrl();
  status = `ready in ${(performance.now() - t0).toFixed(0)}ms`;

  const nPan = +(params.get('pan') || 0);
  if (nPan > 0) await runPan(nPan);
  const nFling = +(params.get('fling') || 0);
  if (nFling > 0) await runFling(nFling);
  if (params.has('sweep')) await runSweep();
  if (params.has('check')) await runCheck();
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
  // The zoom floor is the bottom of the range: a switch point below it is one
  // the camera cannot reach, and reporting it would describe a viewer nobody
  // can drive.
  const lo = cam.minScale || Math.min(cam.resW / chip.w, cam.resH / chip.h) / 2;
  const hi = ladder[ladder.length - 1].minScale * H * 3;

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

// ---------------------------------------------------------------- blank check
//
// One invariant, checked everywhere it could fail: at no level, anywhere inside
// the die, does the viewer draw nothing where geometry exists - and the
// instances it says it culled in are the instances it actually drew.
//
// Both of the bugs this was written for were invisible to tools/verify.js and
// always would have been. Neither was a tile with the wrong bytes in it. One was
// a slot index left high by a level the camera had already left, which inflated
// the stride of the per-instance origin table until whole block instances no
// longer fit in it. The other was culling an instance for having no tiles under
// the viewport at a level where the geometry there lives in the overflow list
// instead. Tile content was correct throughout; the residency state was not.
// Runtime state needs a runtime check.
//
// The sample points come from the data, not from a grid over the die: the
// coarsest far tile holds one block per region that has anything in it, so its
// block centres are exactly the points where geometry provably exists. The
// centres of the finest level's coverage holes are added to them, because a
// hole is where a macro was promoted out of the tiles and is the one place the
// tiles alone cannot answer for.
const CHECK_MIN_PIXELS = 1;      // one lit pixel in the sample window is enough
const CHECK_WINDOW = 24;         // device px, centred: what is under the camera

// Non-background pixels in a small window at the centre of the view. The centre
// is where the sample point is, so this asks the one question that matters: is
// anything drawn at the coordinate we navigated to.
function litPixels() {
  const w = Math.min(CHECK_WINDOW, cam.resW), h = Math.min(CHECK_WINDOW, cam.resH);
  const x = Math.max(0, (cam.resW - w) >> 1), y = Math.max(0, (cam.resH - h) >> 1);
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  // The clear colour, as bytes. Compared with a tolerance because the depth
  // ramp and blending can land a drawn pixel very close to it.
  const bg = [14, 14, 17];
  let lit = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (Math.abs(buf[i] - bg[0]) + Math.abs(buf[i + 1] - bg[1]) + Math.abs(buf[i + 2] - bg[2]) > 6) lit++;
  }
  return lit;
}

// Block centres of the coarsest far tile, in block coordinates. Every one of
// them is a region the generator found something in.
function contentPoints(limit) {
  const z0 = levelZs[0];
  const t = store.peek(key(z0, 0, 0));
  if (!t || t.count === 0) return [];
  const out = [];
  const step = Math.max(1, Math.floor(t.count / limit));
  for (let i = 0; i < t.count; i += step) {
    const b = i * 8;
    out.push([t.originX + t.blocks[b] + t.blocks[b + 2] / 2,
              t.originY + t.blocks[b + 1] + t.blocks[b + 3] / 2]);
  }
  return out;
}

// One point per coverage hole at each level: a connected run of tiles that do
// not exist, enclosed by tiles that do. A hole is a feature promoted out of the
// tiles into the level's overflow list - in this design, a macro - and it is the
// exact place where a level's tiles hold nothing and something must still be
// drawn. Grouped rather than sampled per tile, because a 10x7 macro is one
// thing to check, not seventy.
function holePoints(z) {
  const L = levelOf(z), n = L.tilesPerSide, S = L.tileSize;
  const seen = new Uint8Array(n * n);
  const out = [];
  for (let y0 = 0; y0 < n; y0++) {
    for (let x0 = 0; x0 < n; x0++) {
      if (seen[y0 * n + x0] || store.exists(z, x0, y0)) continue;
      let sx = 0, sy = 0, count = 0, bordered = false;
      const stack = [[x0, y0]];
      seen[y0 * n + x0] = 1;
      while (stack.length) {
        const [x, y] = stack.pop();
        sx += x; sy += y; count++;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          if (store.exists(z, nx, ny)) { bordered = true; continue; }
          if (seen[ny * n + nx]) continue;
          seen[ny * n + nx] = 1;
          stack.push([nx, ny]);
        }
      }
      // Only enclosed holes: the empty margin outside the die is not a hole,
      // and there is nothing to draw there.
      if (bordered) out.push([(sx / count + 0.5) * S, (sy / count + 0.5) * S]);
    }
  }
  return out;
}

// One block instance per orientation the chip actually places, capped. The
// transform is what turns a block coordinate into a chip one, and an
// orientation that does not round-trip shows up as an empty frame like anything
// else. A second instance of an orientation already covered is the same check
// again through the same code.
const CHECK_INSTANCES = 4;

async function runCheck() {
  const t0 = performance.now();
  // Load the coarsest tile first: the sample points are read out of it.
  auto = false; wantZ = levelZs[0];
  cam.scale = cam.minScale; cam.x = chip.w / 2; cam.y = chip.h / 2;
  refresh();
  await store.settle();
  apply();

  const insts = [];
  const seen = new Set();
  for (const inst of chip.instances) {
    if (seen.has(inst.orient)) continue;
    seen.add(inst.orient);
    insts.push(inst);
    if (insts.length >= CHECK_INSTANCES) break;
  }

  // Read once, while the coarsest tile is certainly resident: it is a cache
  // entry like any other and the sweep is about to churn the cache hard.
  const content = contentPoints(12);
  if (!content.length) throw new Error('blank check: no content points - is z0 loaded?');

  const fails = [];
  let samples = 0;

  // Park the camera, let the network settle, draw, and read the two things that
  // can be wrong: an instance culled in but not drawn, and nothing on screen.
  // `emptyOk` is for the fill views of phase two, which exist to load tiles and
  // are not aimed at a point where geometry has to be.
  const at = async (z, scale, x, y, what, emptyOk) => {
    wantZ = z; cam.scale = scale; cam.x = x; cam.y = y;
    refresh();
    await store.settle();
    apply();
    renderer.draw(cam);
    samples++;
    const R = renderer;
    const where = `${what} - drawn at z${useZ} ${KIND_NAME[R.kind]}, scale ${cam.scale.toExponential(2)}, ` +
                  `${R.resident.size} tiles resident, stride ${R.tileStride}`;
    if (R.instances.length !== instanceDraws.length || R.instancesDropped !== 0) {
      fails.push(`drew ${R.instances.length} of ${instanceDraws.length} culled-in block instances ` +
                 `(${R.instancesDropped} dropped) - ${where}`);
    }
    if (!emptyOk) {
      const lit = litPixels();
      if (lit < CHECK_MIN_PIXELS) {
        fails.push(`empty frame over geometry: ${lit} lit pixels in ` +
                   `${CHECK_WINDOW}x${CHECK_WINDOW}, ${fmt(R.drawn.rects)} rects - ${where}`);
      }
    }
  };

  // ---- phase one: every sample point, at every level ---------------------
  //
  // Finest level first. The order is not cosmetic: the tile slots a level
  // leaves behind are what the next level allocates from, so walking downwards
  // is the same direction a person navigates.
  for (const z of [...levelZs].reverse()) {
    const before = fails.length, atLevel = samples;
    // The scale this level is actually selected at, never below the camera's
    // floor - a level checked at a scale the viewer cannot reach proves nothing.
    const scale = Math.max(cam.minScale, picker.band(z)[1]);
    const points = [...content, ...holePoints(z)];
    for (const inst of insts) {
      for (const [bx, by] of points) {
        await at(z, scale, inst.T.toChipX(bx, by), inst.T.toChipY(bx, by),
                 `z${z} ${levelOf(z).kind} instance ${inst.i} at block ${Math.round(bx)},${Math.round(by)}`);
      }
    }
    // Reported per level rather than at the end: this runs for minutes on a
    // software rasteriser, and a gate that prints nothing until it is done
    // looks like a gate that has hung.
    report(`  z${z} ${levelOf(z).kind}  ${samples - atLevel} samples, ` +
           `${fails.length - before} failures  (${(performance.now() - t0).toFixed(0)}ms)`);
  }

  // ---- phase two: the residency transition -------------------------------
  //
  // Sampling levels one at a time never asks the question that made whole block
  // instances vanish, because that failure needs two views in sequence: one
  // that fills the tile slots, and then the chip view, which draws more block
  // instances at once than any other. So drive exactly that - fill at each
  // level up to the fetch rail, then go straight out to the whole chip.
  //
  // The fill scale comes from the rail rather than from the canvas: the level
  // is asked for very nearly maxVisibleTiles tiles, which is the most the
  // viewer will ever hold resident, whatever size the window is. A gate whose
  // coverage depended on the window would prove nothing on a small one.
  const before2 = fails.length, atPhase2 = samples;
  const across = Math.max(1, Math.floor(Math.sqrt(maxVisibleTiles)) - 1);
  for (const z of [...levelZs].reverse()) {
    const L = levelOf(z);
    await at(z, Math.max(cam.minScale, cam.resW / (across * L.tileSize)),
             chip.instances[0].T.toChipX(L.tileSize * across / 2, L.tileSize * across / 2),
             chip.instances[0].T.toChipY(L.tileSize * across / 2, L.tileSize * across / 2),
             `fill at z${z} ${L.kind}`, true);
    await at(levelZs[0], cam.minScale, chip.w / 2, chip.h / 2,
             `whole chip after filling z${z} ${L.kind}`);
  }
  report(`  transition  ${samples - atPhase2} samples, ${fails.length - before2} failures ` +
         `(${(performance.now() - t0).toFixed(0)}ms)`);

  const ms = (performance.now() - t0).toFixed(0);
  report(`blank check  ${cam.resW}x${cam.resH} canvas, ${levelZs.length} levels, ` +
         `${insts.length} block instances, ${samples} samples in ${ms}ms`);
  for (const f of fails.slice(0, 40)) report('  FAIL ' + f);
  status = fails.length
    ? `blank check FAILED: ${fails.length} of ${samples} samples`
    : `blank check passed: ${samples} samples across ${levelZs.length} levels, nothing empty, no instance dropped`;
  report('  ' + status);
  auto = true;
  picker.seed(useZ);
  // The one hook a headless run needs, and the reason it exists: an exit code
  // has to come from somewhere. tools/check.js reads exactly this.
  window.manhattanCheck = { pass: fails.length === 0, samples, fails, ms: +ms };
  return window.manhattanCheck;
}

// Awaited, not fire-and-forget: the page's load event waits for it, so a
// scripted run cannot screenshot and exit before the numbers are delivered.
// (was sendBeacon page teardown; a plain fetch races the screenshot and
// loses often enough to make scripted runs unreliable.
function report(msg) {
  const url = '/__log?msg=' + encodeURIComponent(msg);
  if (!(navigator.sendBeacon && navigator.sendBeacon(url))) fetch(url).catch(() => {});
}

// ---------------------------------------------------------------- identify
//
// The click resolves through the same transform and the same tile arithmetic
// the culling path uses; see src/pick.js. What comes back is what the format
// actually carries, which is not everything a person would want - there are no
// names in masters.bin or in a placement record, so a master is its index and a
// placement is its coordinates. Saying so beats inventing an identifier.
let selection = null;

let pickPoint = null;

function identify(px, py) {
  if (!renderer || !manifest) return;
  identifyAt(cam.x + (px - cam.resW / 2) / cam.scale,
             cam.y + (py - cam.resH / 2) / cam.scale);
}

// The panel is a reading of one point at one level, and both halves have to be
// current. It used to be written once at click time and left there, so zooming
// out to the chip left a readout naming the level the click was made at while
// the HUD named the level actually on screen. Re-resolved whenever the level
// changes or the resident set does, against whatever is drawn now.
let pickZ = -1;

function refreshSelection() {
  if (!pickPoint || !renderer) return;
  if (useZ === pickZ && !renderer.lastAdded && !renderer.lastRemoved) return;
  identifyAt(pickPoint[0], pickPoint[1]);
}

function identifyAt(cx, cy) {
  selection = pick(cx, cy, { chip, store, level: levelOf(useZ), masters: renderer.masters });
  // The click is the point, whether or not something was under it. Forgetting a
  // miss would mean the readout could never come back when the level that does
  // hold geometry there arrives.
  pickPoint = [cx, cy];
  pickZ = useZ;
  // The hit, in chip space. Every orientation is axis-preserving, so the two
  // transformed corners are the rect - no rotated outline to draw.
  if (selection) {
    const T = selection.inst.T;
    const ax = T.toChipX(selection.x, selection.y), ay = T.toChipY(selection.x, selection.y);
    const bx = T.toChipX(selection.x + selection.w, selection.y + selection.h);
    const by = T.toChipY(selection.x + selection.w, selection.y + selection.h);
    renderer.selectionBox = {
      x: Math.min(ax, bx), y: Math.min(ay, by),
      w: Math.abs(bx - ax), h: Math.abs(by - ay),
    };
  } else {
    renderer.selectionBox = null;
  }
  drawPanel(cx, cy);
  syncUrl();
}

const nm = v => `${fmt(Math.round(v))} nm`;
const um = v => `${(v / 1000).toFixed(2)} um`;

function drawPanel(cx, cy) {
  const s = selection;
  if (!s) {
    panel.textContent = `nothing at ${nm(cx)}, ${nm(cy)}   (level z${useZ} ${levelOf(useZ).kind})`;
    panel.classList.add('on');
    return;
  }
  const inst = s.inst;
  const where = `block instance ${inst.i} / ${chip.count}  ${ORIENT_NAME[inst.orient]} at ${nm(inst.x)}, ${nm(inst.y)}`;

  if (s.kind === 'placement') {
    panel.textContent =
`placement    master #${s.master}  ${KLASS_NAME[s.klass] || '?'}   ${um(s.w)} x ${um(s.h)}   orient ${ORIENT_NAME[s.orient]}
             block  ${nm(s.x)}, ${nm(s.y)}      chip  ${nm(inst.T.toChipX(s.x, s.y))}, ${nm(inst.T.toChipY(s.x, s.y))}
             ${where}
             tile   z${s.z} ${s.tx}/${s.ty}   placement ${fmt(s.index)} / ${fmt(s.tile.count)}${s.tile.isOverflow ? ' (overflow list)' : ''}${s.overlaps ? `   +${s.overlaps} overlapping` : ''}
             no names in the format: #${s.master} is the master's index in masters.bin, and the placement's identity is its position`;
  } else {
    const occ = s.density + s.fill;
    panel.textContent =
`density      logic ${(100 * s.density).toFixed(1)}%   filler ${(100 * s.fill).toFixed(1)}%   ` +
`${occ > 1e-4 ? `dead ${(100 * s.fill / occ).toFixed(0)}% of what is occupied` : 'empty'}
             block  ${um(s.w)} x ${um(s.h)} at ${nm(s.x)}, ${nm(s.y)} in the block
             ${where}
             tile   z${s.z} ${s.tx}/${s.ty}   block ${fmt(s.index)} / ${fmt(s.tile.count)}
             a far level holds no placements - this is merged density, not a cell`;
  }
  panel.classList.add('on');
}

function clearPanel() {
  selection = null;
  pickPoint = null;
  if (renderer) renderer.selectionBox = null;
  panel.classList.remove('on');
  syncUrl();
}

// ---------------------------------------------------------------- jump to
//
// What the workflow actually needs: a tool says "violation at (482100, 918400)"
// and the answer has to be one paste away. Chip coordinates, because that is
// what a chip-level tool reports; the block instance is resolved rather than
// asked for.
function openJump() {
  bar.classList.add('on');
  jumpInput.value = '';
  jumpInput.focus();
}
function closeJump() { bar.classList.remove('on'); jumpInput.blur(); }

// Accepts what a tool or a person actually produces: "482100, 918400",
// "482100 918400", "(482100,918400)", "x=482100 y=918400", and the
// comma-grouped form the panel itself prints, "482,100, 918,400".
//
// A comma counts as a thousands separator only when it is followed by exactly
// three digits and then something that is not a digit - which is what tells
// "482,100" apart from "482100,918400". Anything that leaves other than two
// numbers is refused rather than guessed at: silently reading "4 100 000" as
// y = 4 would send someone to the wrong place and look like it worked.
export function parseCoordinate(text) {
  const cleaned = String(text).replace(/,(?=\d{3}(\D|$))/g, '').replace(/_/g, '');
  const found = cleaned.match(/-?\d+(\.\d+)?/g) || [];
  if (found.length !== 2) return { error: `expected two numbers, found ${found.length}` };
  const x = +found[0], y = +found[1];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'not a coordinate' };
  return { x, y };
}

function jumpTo(text) {
  const parsed = parseCoordinate(text);
  if (parsed.error) {
    status = `"${text}": ${parsed.error} - give x and y in nm`;
    return;
  }
  const { x, y } = parsed;

  cam.x = x; cam.y = y;
  // Zoom in if the view is coarser than this, but never zoom out: arriving at a
  // reported coordinate should show geometry, and someone already deep in a
  // block does not want to be pulled back out.
  const want = JUMP_CELL_PX / (manifest.meanCellWidth || 700);
  if (cam.scale < want) cam.scale = want;

  const hit = chip.visible({ minX: x, minY: y, maxX: x, maxY: y })[0];
  status = hit
    ? `jumped to ${nm(x)}, ${nm(y)} - block instance ${hit.i} of ${chip.count}`
    : `jumped to ${nm(x)}, ${nm(y)} - outside every block instance`;
  closeJump();
  refresh();
  syncUrl();
}

// ---------------------------------------------------------------- shareable url
//
// The one thing a desktop layout viewer structurally cannot do: hand someone
// else exactly what is on your screen. The parameters are the same ones the
// loader has always accepted, so the URL is symmetric - what it writes, it can
// read back.
//
// replaceState on a trailing throttle, never pushState: a pan is not a
// navigation, and the back button should leave the page rather than walk
// backwards through every frame of it.
const URL_THROTTLE_MS = 350;
let urlTimer = 0;

function syncUrl() {
  if (urlTimer) return;
  urlTimer = setTimeout(() => { urlTimer = 0; writeUrl(); }, URL_THROTTLE_MS);
}

function writeUrl() {
  if (!renderer || !manifest) return;
  const p = new URLSearchParams(location.search);
  // One-shot commands, not view state: a shared link should not re-run a
  // benchmark on the person who opens it.
  for (const k of ['pan', 'fling', 'sweep', 'check']) p.delete(k);

  p.set('view', `${Math.round(cam.x)},${Math.round(cam.y)},${cam.scale.toPrecision(6)}`);
  if (auto) { p.delete('z'); p.delete('auto'); } else { p.set('z', String(useZ)); p.set('auto', '0'); }

  // With solo on, the mask IS the solo bit; what is worth restoring is the mask
  // the solo was entered from, so that leaving solo returns somewhere useful.
  const mask = soloLayer >= 0 ? maskBeforeSolo : renderer.layerMask;
  if (mask === 0xffff) p.delete('mask'); else p.set('mask', '0x' + (mask >>> 0).toString(16));
  if (soloLayer >= 0) p.set('solo', String(soloLayer)); else p.delete('solo');
  if (renderer.colorMode) p.set('color', '1'); else p.delete('color');
  // Written only when it is not the default, on the same rule as color and
  // alpha: what the URL writes it can read back, without every shared link
  // carrying the state it would have had anyway.
  if (hudMode !== HUD_FULL) p.set('hud', HUD_KEYS[hudMode]); else p.delete('hud');
  if (renderer.translucent) p.set('alpha', '1'); else p.delete('alpha');
  if (pickPoint) p.set('pick', `${Math.round(pickPoint[0])},${Math.round(pickPoint[1])}`);
  else p.delete('pick');

  // Hand-built rather than p.toString(), which percent-encodes the commas in
  // view= and turns a readable link into a wall of %2C.
  const safe = v => (/^[\w.,:+\-/]*$/.test(v) ? v : encodeURIComponent(v));
  const q = [...p.entries()].map(([k, v]) => `${k}=${safe(v)}`).join('&');
  history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
}

let refreshQueued = false;
function onCameraChange() {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => { refreshQueued = false; refresh(); });
  syncUrl();
}

attachControls(canvas, cam, onCameraChange, identify);
window.addEventListener('resize', () => { resize(); onCameraChange(); });
// Alpha for the translucent path. Everything a process engineer wants to see
// through is routing: metal over via over metal. The lower layers stay nearly
// opaque so the cell still reads as a cell.
const ALPHA_PRESET = [1, 1, 0.85, 0.85, 0.8, 0.55, 0.6, 0.5, 0.45, 0.7, 0.9, 0.5, 1, 1, 1, 1];

function setTranslucent(R, on) {
  R.translucent = on;
  for (let i = 0; i < 16; i++) R.layerAlpha[i] = on ? ALPHA_PRESET[i] : 1;
}

// ---------------------------------------------------------------- display
//
// The HUD is a debugger, and once you are reading the design rather than the
// viewer it is a green panel over a third of the layout. Three states rather
// than two, because the middle one is the useful one while navigating: where
// the ladder is, what it costs against the budget, and the frame rate. Full is
// the default - the first question about a new viewer is what it is doing.
const HUD_FULL = 0, HUD_LINE = 1, HUD_OFF = 2;
const HUD_MODE_NAME = ['full', 'one line', 'off'];
const HUD_KEYS = ['full', 'line', 'off'];      // what ?hud= accepts
let hudMode = HUD_FULL;

function setHudMode(m) {
  hudMode = (m + 3) % 3;
  hud.classList.toggle('off', hudMode === HUD_OFF);
}

// The controls, grouped by what you are trying to do rather than by keycap
// order. They used to live on two lines at the bottom of the HUD, which put
// them behind the one control that hides them.
const HELP_GROUPS = [
  ['navigate', [
    ['drag', 'pan'],
    ['wheel', 'zoom, stopping at fit-to-die'],
    ['f', 'fit the die'],
    ['g', 'go to an x, y coordinate in nm'],
    ['click', 'identify what is under the cursor'],
    ['esc', 'dismiss the panel or the coordinate box'],
  ]],
  ['level', [
    ['l', 'automatic / manual LOD level'],
    ['[  ]', 'force the level down / up (switches to manual)'],
  ]],
  ['layers', [
    ['1-9', 'toggle a layer'],
    ['shift+1-9', 'solo a layer, hide the rest'],
    ['a', 'all layers on / off'],
    ['v', 'per-layer alpha, see through the stack'],
    ['', 'far and mid levels carry no layer identity, so filters do not apply there'],
  ]],
  ['display', [
    ['d', 'HUD: full / one line / off'],
    ['?  h', 'this panel'],
    ['c', 'colour by layer or by cell class'],
    ['b', 'block instance outlines'],
    ['p', 'subpixel skip'],
  ]],
  ['diagnostics', [
    ['t', 'tile bounds and content boxes'],
    ['r', 'reset the worst-update timer'],
    ['-  =', 'halve / double the tile cache budget'],
  ]],
];

function buildHelp() {
  const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows = [];
  for (const [title, keys] of HELP_GROUPS) {
    rows.push(`<i>${title}</i>`);
    for (const [k, what] of keys) rows.push(`  <b>${esc(k).padEnd(11)}</b>${esc(what)}`);
    rows.push('');
  }
  rows.push('<i>the URL is the view</i>');
  rows.push('  it updates as you navigate; opening it restores exactly this screen');
  help.innerHTML = rows.join('\n');
}

function toggleHelp() {
  if (!help.innerHTML) buildHelp();
  help.classList.toggle('on');
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
  // While the jump box has focus it owns the keyboard; layer keys would
  // otherwise fire on every digit typed into a coordinate.
  if (e.target === jumpInput) {
    if (e.key === 'Enter') jumpTo(jumpInput.value);
    else if (e.key === 'Escape') closeJump();
    return;
  }
  if (e.key === 'Escape') {
    if (help.classList.contains('on')) { help.classList.remove('on'); return; }
    closeJump(); clearPanel(); return;
  }
  if (e.key === '?' || e.key === 'h') { toggleHelp(); return; }
  if (e.key === 'g') { e.preventDefault(); openJump(); return; }
  // e.code, not e.key: shift turns '1' into '!' and the layer keys have to keep
  // working with it held.
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    const layer = TOGGLE_LAYERS[+digit[1] - 1];
    if (e.shiftKey) solo(R, layer);
    else { R.layerMask ^= 1 << layer; soloLayer = -1; }
    syncUrl();
    return;
  }
  switch (e.key) {
    case 'd': setHudMode(hudMode + 1); status = `HUD ${HUD_MODE_NAME[hudMode]}`; break;
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
  syncUrl();
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

// The counts that go on screen are what is drawn, not what happens to be
// resident: the renderer applies the layer mask before anything reaches the
// rasteriser, and a rectangle count that ignores it reports 48,300 rects over an
// empty frame. Both figures appear when they differ, because the gap IS the
// filter and that is the part worth seeing.
function countLine(R, budget) {
  const n = R.instances.length;
  const d = R.drawn;
  const drawnRects = d.rects * n, residentRects = R.rectCount * n;
  const drawnPl = d.placements * n, residentPl = R.instanceCount * n;
  const of = (a, b) => (a === b ? '' : ` of ${fmt(b)} resident`);
  return `placements ${fmt(drawnPl)}${of(drawnPl, residentPl)}   ` +
    `rects ${fmt(drawnRects)}${of(drawnRects, residentRects)} / ${fmt(budget)} ` +
    `(${(100 * drawnRects / budget).toFixed(0)}%)`;
}

// What the viewer is doing that the picture alone would not tell you, and that
// is not simply how it works. These stay on screen with the HUD off: turning
// the diagnostics off must not turn the warnings off with them.
function warnings(R) {
  const out = [];
  if (R.layerFilterIgnored) {
    out.push(`layer filter ignored - z${useZ} ${KIND_NAME[R.kind]} has no layer identity: ` +
      `${R.kind === 1 ? 'merged density, macros and the power grid' : 'one box per placement'}, ` +
      `not process layers.   ] steps to a level that has them.`);
  }
  if (R.instancesDropped > 0) {
    out.push(`${R.instancesDropped} block instances not drawn - the tile origin table ` +
      `cannot address ${fmt(R.instances.length + R.instancesDropped)} x ${R.tileStride} entries.`);
  }
  if (clamped) {
    out.push(`level clamped to z${useZ} from z${wantZ} - z${wantZ} needs more than ` +
      `${maxVisibleTiles} tiles from here.`);
  }
  return out;
}

function drawNotice(R) {
  const w = warnings(R);
  if (w.length === 0) { notice.classList.remove('on'); return; }
  notice.textContent = w.join('\n');
  notice.classList.add('on');
}

// The floor level applies at every scale below the next level's switch-in, and
// with the camera clamped that lower end is a known number rather than an open
// question. Say where it sits against the scale the level's own content was
// built for, so a floor drawn below what it can show is stated, not implied.
function floorLine() {
  const p = ladder[0];
  if (!p || !p.contentScale) return '';
  const at = `content to ${p.contentScale.toExponential(2)}`;
  if (!(p.floorSlack > 1)) return `   z${p.z} floor: ${at}, reachable to ${p.floorReach.toExponential(2)}`;
  return `   z${p.z} floor: ${at} but reachable to ${p.floorReach.toExponential(2)}, ` +
         `${p.floorSlack.toFixed(1)}x below what it was built for`;
}

function drawHud(dt) {
  const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
  const R = renderer;
  drawNotice(R);
  if (hudMode === HUD_OFF) return;

  const s = store.stats;
  const L = levelOf(useZ);
  const budget = manifest.rectBudget;
  const fps = (1000 / avg).toFixed(1);
  // One line is what is worth carrying while navigating: where the ladder is,
  // what it costs against the budget, and whether the frame is keeping up.
  if (hudMode === HUD_LINE) {
    hud.textContent = `z${useZ}/${manifest.maxZ} ${KIND_NAME[R.kind]} ${auto ? 'auto' : 'MANUAL'}   ` +
      `${countLine(R, budget)}   fps ${fps}`;
    return;
  }

  const band = picker.band(useZ);
  const bound = (ladder.find(p => p.z === useZ) || {}).bound;
  const est = picker.estimate(useZ, view, cam.scale);
  const nmPerPx = 1 / cam.scale;
  const reqs = s.loaded + s.hits;
  hud.textContent =
`LOD        z ${useZ} / ${manifest.maxZ}   ${KIND_NAME[R.kind]}   tile ${(L.tileSize / 1000).toFixed(1)}um   bleed ${(L.maxOverhang / 1000).toFixed(1)}um   ${auto ? 'auto' : 'MANUAL'}` +
  `${clamped ? `   (clamped from z${wantZ})` : ''}
ladder     ${ladderLine()}   holds >= ${band[0].toExponential(2)}, switches in at ${band[1].toExponential(2)} (${bound})   est ${fmt(Math.round(est))} rects${floorLine()}
chip       ${fmt(R.instances.length)} / ${fmt(chip.count)} block instances on screen${R.instancesDropped ? `   ${R.instancesDropped} NOT DRAWN` : ''}   draws ${fmt(R.drawCalls)}   ${chipNote}
tiles      resident ${fmt(R.resident.size)}/${fmt(uniqueTiles)} unique, ${fmt(lastCandidates)} drawn${L.overflow ? ` +ovf ${fmt(L.overflow.count)}` : ''}   inflight ${fmt(store.active)}  queued ${fmt(store.queue.length)}  loaded ${fmt(s.loaded)}  hit ${reqs ? (100 * s.hits / reqs).toFixed(0) : 0}%
cache      ${mb(store.bytes)} / ${store.budgetMB.toFixed(0)} MB  (pinned ${mb(store.pinnedBytes)})   evicted ${fmt(s.evicted)} = ${mb(s.evictedBytes)} MB   aborted ${fmt(s.aborted)}  dropped ${fmt(s.dropped)}
${countLine(R, budget)}   submitted ${fmt(R.submittedRects)} (+${(100 * (R.submittedRects / Math.max(1, R.rectCount) - 1)).toFixed(0)}% bucket pad)
masters    ${fmt(R.distinctMasters)} distinct of ${fmt(R.masters.masterCount)} in library   draws ${fmt(R.drawCalls)}   buckets [${R.caps.join(',')}]
update     last ${R.updateMs.toFixed(2)} ms (+${R.lastAdded}/-${R.lastRemoved} tiles)   worst ${R.updateWorstMs.toFixed(2)} ms   count ${fmt(R.updates)}   slot waste ${(100 * R.waste).toFixed(0)}%
frame      ${dt.toFixed(2)} ms  (submit ${submitMs.toFixed(2)} ms)   fps(60) ${fps}
memory     masters ${mb(R.masters.bytes)} MB   gpu slots ${mb(R.poolBytes)} MB   tile table ${fmt(R.tileEntries)} entries
zoom       ${cam.scale.toExponential(2)} px/nm   ${nmPerPx < 1 ? (nmPerPx * 1000).toFixed(1) + ' pm/px' : nmPerPx.toFixed(1) + ' nm/px'}${cam.atZoomFloor ? '   at the zoom floor' : ''}   origin ${R.originX.toFixed(0)},${R.originY.toFixed(0)}
layers     ${layerLine(R)}   ${R.hasLayerIdentity ? (soloLayer >= 0 ? `SOLO ${LAYER_NAMES[soloLayer]}` : '(+ visible, - hidden)') : `not applied at z${useZ} ${KIND_NAME[R.kind]}`}
color      ${R.colorMode ? `by class: ${CLASS_LAYER_NAMES.join(' / ')}` : 'by layer'}   ${R.translucent ? 'translucent (layer passes)' : 'opaque'}   density ${(100 * R.densityRange[0]).toFixed(0)}-${(100 * R.densityRange[1]).toFixed(0)}%   tiles ${R.showTiles ? 'on' : 'off'}   blocks ${R.blockBounds ? 'on' : 'off'}   minPx ${R.minPx.toFixed(1)}   ring ${PREFETCH_RING}
keys       ? or h for all of them, d for this panel
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
