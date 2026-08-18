// Manhattan viewer.
//
// Step 1: load masters.bin plus a single deepest-level tile and draw it, to
// prove the generator -> disk -> fetch -> GPU round trip end to end. Camera,
// origin fix, batching and the HUD are the real implementations; the tile set
// is just fixed to whatever the manifest lists.

import { viewMasters } from './format.js';
import { Camera, attachControls } from './camera.js';
import { Renderer } from './renderer.js';
import { TileStore } from './tiles.js';

const params = new URLSearchParams(location.search);
const DATA = params.get('data') || '../data';
const CACHE_MB = +(params.get('cache') || 256);

const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const gl = canvas.getContext('webgl2', { antialias: false, depth: true });
if (!gl) {
  document.body.innerHTML = '<p style="color:#c66;font:14px monospace;padding:2em">WebGL2 not available.</p>';
  throw new Error('no webgl2');
}

const cam = new Camera();
const store = new TileStore(DATA, CACHE_MB);

let manifest = null, renderer = null, level = null;
let visible = [];
let drawCalls = 0, minPx = 0;
let status = 'loading...';

function resize() {
  cam.dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * cam.dpr);
  const h = Math.round(canvas.clientHeight * cam.dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
  cam.resW = w; cam.resH = h;
}

async function boot() {
  resize();
  const t0 = performance.now();

  manifest = await (await fetch(`${DATA}/manifest.json`)).json();
  level = manifest.levels[0];

  const masters = viewMasters(await (await fetch(`${DATA}/masters.bin`)).arrayBuffer());
  renderer = new Renderer(gl, masters);

  const [tx, ty] = level.tiles[0];
  const tile = await store.load(level.z, tx, ty);
  visible = [tile];

  cam.fit(tile.originX + tile.minX, tile.originY + tile.minY,
          tile.originX + tile.maxX, tile.originY + tile.maxY);

  // ?view=cx,cy,scale pins an exact camera, for reproducible screenshots.
  const v = params.get('view');
  if (v) {
    const [cx, cy, sc] = v.split(',').map(Number);
    if (Number.isFinite(cx)) cam.x = cx;
    if (Number.isFinite(cy)) cam.y = cy;
    if (Number.isFinite(sc)) cam.scale = sc;
  }
  renderer.setVisible(visible, cam);

  status = `ready in ${(performance.now() - t0).toFixed(0)}ms`;
  requestAnimationFrame(frame);
}

// The staging buffer only needs rebuilding when the view origin drifts far
// enough to threaten f32 precision. Panning and zooming alone are uniforms.
function onCameraChange() {
  if (renderer && renderer.needsResnap(cam)) renderer.setVisible(visible, cam);
}

attachControls(canvas, cam, onCameraChange);
window.addEventListener('resize', resize);
window.addEventListener('keydown', e => {
  if (!renderer) return;
  if (e.key === 'f' && visible.length) {
    const t = visible[0];
    cam.fit(t.originX + t.minX, t.originY + t.minY, t.originX + t.maxX, t.originY + t.maxY);
    onCameraChange();
  }
  if (e.key === 'p') { minPx = minPx > 0 ? 0 : 1; }
});

// ---------------------------------------------------------------- loop
const dts = [];
let lastT = 0, gpuMs = 0;

function frame(t) {
  resize();
  const dt = lastT ? t - lastT : 16.7;
  lastT = t;
  dts.push(dt);
  if (dts.length > 60) dts.shift();

  const d0 = performance.now();
  drawCalls = renderer.draw(cam, minPx);
  gpuMs = performance.now() - d0;

  drawHud(dt);
  requestAnimationFrame(frame);
}

const fmt = n => n.toLocaleString('en-US');
const mb = b => (b / (1024 * 1024)).toFixed(2);

function drawHud(dt) {
  const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
  const s = store.stats;
  const nmPerPx = 1 / cam.scale;
  hud.textContent =
`LOD        z ${level.z} / ${manifest.maxZ}   tile ${(level.tileSize / 1000).toFixed(1)}um   ${level.kind}
tiles      loaded ${fmt(s.loaded)}  cached ${fmt(store.cache.size)}  evicted ${fmt(s.evicted)}  hits ${fmt(s.hits)}
instances  ${fmt(renderer.instanceCount)}   rects ${fmt(renderer.rectCount)}   draws ${fmt(drawCalls)}
frame      ${dt.toFixed(2)} ms  (submit ${gpuMs.toFixed(2)} ms)   fps(60) ${(1000 / avg).toFixed(1)}
cache      ${mb(store.bytes)} MB / ${store.budgetMB.toFixed(0)} MB   masters ${mb(renderer.masters.bytes)} MB
zoom       ${cam.scale.toExponential(2)} px/nm   ${nmPerPx < 1 ? (nmPerPx * 1000).toFixed(1) + ' pm/px' : nmPerPx.toFixed(1) + ' nm/px'}
origin     ${renderer.originX.toFixed(0)}, ${renderer.originY.toFixed(0)} nm   resnaps ${renderer.rebuilds}  (${renderer.lastRebuildMs.toFixed(1)} ms)
minPx      ${minPx.toFixed(1)}   [drag pan, wheel zoom, f fit, p subpixel skip]
${status}`;
}

boot().catch(e => {
  status = String(e);
  hud.textContent = `boot failed: ${e.message}\n\nRun the generator first:\n  node tools/gen.js --count 500k --one-tile\nthen serve the repo root:\n  node tools/serve.js`;
  console.error(e);
});
