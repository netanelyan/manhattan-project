// WebGL2 renderer.
//
// DRAW GROUPING. Deep tiles are grouped by *rect count bucket*, not by master.
// Every instance carries its master id and the vertex shader looks the geometry
// up in a texture, so one draw call covers every master in the bucket. Grouping
// by master made the draw count equal the library size - ~4,600 for a real
// cells.lef, which does not fit a 16.7ms frame. Bucketing makes it a constant:
// one call per bucket, four of them, whatever the library holds. The price is
// surplus vertices for masters below their bucket cap, discarded as degenerate
// triangles.
//
// BUFFERS. Slots are persistent. A slot record is origin-independent -
// tile-local coordinates plus a tile index - so it is written once when a tile
// loads and never rewritten. Panning changes a uniform; a view-origin resnap
// changes a small per-tile origin table. Neither rebuilds a buffer. A
// visible-set change costs only the tiles entering and leaving.
//
// TEXTURES. masters.bin is uploaded verbatim as two RGBA32I textures - the
// master table (2 texels per master: rectStart, rectCount, w, h / klass, rowH)
// and the rect table (2 texels per rect). No CPU-side geometry expansion.
//
// BLOCK INSTANCES. A chip is N instances of one block, so the same resident
// tiles are drawn once per visible instance: same slots, same buffers, one
// extra uniform pair per draw. The per-tile table is indexed (instance, slot)
// rather than (slot), and each entry is that tile's origin already transformed
// into chip space and made relative to the view origin - so the f64 work stays
// on the CPU exactly as it did with one block. Orientation rides along as a 2x2
// of 0s and +/-1s applied to tile-local coordinates, which costs two multiplies
// and two adds per vertex and nothing at all in bandwidth.

import { RECT_TEX_WIDTH, TILE_KIND, I_STRIDE, KLASS,
         LAYER_CELLBOX, LAYER_MACROBOX, LAYER_POWERBOX } from './format.js';
import { SlotPool } from './pool.js';
import { PLACEMENT_SLOT_I32, BLOCK_SLOT_I32, buildPlacementSlots, buildBlockSlots,
         fillFreePlacements, fillFreeBlocks, tileBuckets } from './slots.js';

export const LAYER_NAMES = [
  'outline', 'nwell', 'diff', 'poly', 'contact', 'metal1',
  'via1', 'metal2', 'metal3', 'pin', 'macro', 'power',
  'cellbox', 'macrobox', 'powerbox', '-',
];
const PALETTE = [
  [0.23, 0.23, 0.27], [0.16, 0.18, 0.23], [0.18, 0.42, 0.31], [0.69, 0.29, 0.29],
  [0.85, 0.85, 0.85], [0.24, 0.44, 0.72], [0.81, 0.81, 0.38], [0.72, 0.40, 0.24],
  [0.48, 0.31, 0.72], [0.88, 0.75, 0.25], [0.29, 0.29, 0.35], [0.78, 0.31, 0.24],
  [0.34, 0.52, 0.74], [0.40, 0.38, 0.50], [0.82, 0.34, 0.26], [0, 0, 0],
  // 16 + klass: colour by cell class. The depth key still uses the abstract
  // layer, so colour and ordering are separate - which is what lets filler have
  // its own colour without floating above the power grid.
  [0.34, 0.52, 0.74],   // standard cell
  [0.40, 0.38, 0.50],   // macro
  [0.82, 0.34, 0.26],   // power
  [0.28, 0.27, 0.31],   // filler / decap: occupied, not doing anything
];
const CLASS_NAMES = ['cell', 'macro', 'power', 'filler'];
const PALETTE_SIZE = 20;

// Keys 1-9 toggle these layers: the ones worth hiding while reading a layout.
export const TOGGLE_LAYERS = [2, 3, 4, 5, 6, 7, 8, 9, 11];
export const CLASS_LAYER_NAMES = CLASS_NAMES;

const MAX_TILE_SLOTS = 1024;      // resident tiles addressable by the origin table
const MAX_TILE_ENTRIES = 4096;    // (instance, tile) pairs the table can hold
const TILE_TEX_WIDTH = 256;
// One block instance drawn as itself: what a viewer with no chip beside it uses.
const IDENTITY_INSTANCE = { m: [1, 0, 0, 1], tx: 0, ty: 0, keys: null };
const LOG2_TEXW = Math.log2(RECT_TEX_WIDTH) | 0;

// Shared shader preamble: master/rect lookup, the per-tile origin table, layer
// visibility, colour mode, and the projection that uses the layer id as a depth
// key so painting order needs no sorting.
const COMMON = `
precision highp float;
precision highp int;

uniform highp isampler2D u_masters;   // 2 texels per master
uniform highp isampler2D u_rects;     // 2 texels per rect
uniform highp sampler2D  u_tiles;     // per-tile origin minus view origin

uniform vec2  u_cam;
uniform float u_scale;
uniform vec2  u_res;
uniform int   u_tileBase;             // this instance's window into the tile table
uniform vec4  u_rot;                  // block orientation, column-major mat2
uniform float u_minPx;
uniform int   u_layerMask;
uniform int   u_colorMode;            // 0 = by layer, 1 = by class
uniform float u_layerAlpha[16];       // per layer, 1.0 = opaque
uniform vec2  u_dens;                 // logic density p5..p95, for the ramp

flat out int v_ci;                    // palette index
flat out int v_mode;                  // 0 = flat colour, 1 = density ramp
out float v_density;
out float v_fill;
out float v_alpha;

ivec4 fetchMaster(int i) {
  return texelFetch(u_masters, ivec2(i & ${RECT_TEX_WIDTH - 1}, i >> ${LOG2_TEXW}), 0);
}
ivec4 fetchRect(int i) {
  return texelFetch(u_rects, ivec2(i & ${RECT_TEX_WIDTH - 1}, i >> ${LOG2_TEXW}), 0);
}
// xy: the tile's origin in chip space, relative to the view origin, for THIS
// instance. z < 0 means the tile is not in this instance's visible set - it is
// resident for another instance, so its geometry is dropped here.
vec4 tileEntry(int s) {
  s += u_tileBase;
  return texelFetch(u_tiles, ivec2(s & ${TILE_TEX_WIDTH - 1}, s >> 8), 0);
}
vec2 blockRot(vec2 v) {
  return vec2(u_rot.x * v.x + u_rot.z * v.y, u_rot.y * v.x + u_rot.w * v.y);
}
bool layerHidden(int layer) {
  return (u_layerMask & (1 << layer)) == 0;
}
int classLayer(int klass) {
  return klass == ${KLASS.MACRO} ? ${LAYER_MACROBOX}
       : klass == ${KLASS.PWR}   ? ${LAYER_POWERBOX} : ${LAYER_CELLBOX};
}
// Tile-local coordinates are rotated into the instance's orientation; the tile
// origin is already transformed, on the CPU, in f64.
// depthLayer is the layer id used as the depth key; colour comes from v_ci,
// set by the caller, so colouring by class cannot disturb painting order.
void emitQuad(vec2 origin, vec2 local, vec2 size, vec2 corner, int depthLayer) {
  vec2 p = (origin + blockRot(local + corner * size) - u_cam) * u_scale + 0.5 * u_res;
  float z = 1.0 - float(depthLayer) * (1.0 / 16.0);
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, z, 1.0);
}
void discardVertex() { gl_Position = vec4(0.0, 0.0, 0.0, -1.0); }
`;

// Deep: one draw call per bucket. gl_VertexID splits into (rect index, corner);
// surplus rects beyond this master's own count collapse.
const VS_DEEP = `#version 300 es
${COMMON}
layout(location=0) in ivec2 a_pos;      // tile-local nm
layout(location=1) in int   a_packed;   // masterId | orient<<16, -1 when free
layout(location=2) in int   a_tileSlot;

const int QI[6] = int[6](0, 1, 2, 2, 1, 3);

void main() {
  if (a_packed < 0) { discardVertex(); return; }        // released slot
  vec4 tinfo = tileEntry(a_tileSlot);
  if (tinfo.z < 0.0) { discardVertex(); return; }           // not visible for this instance
  int m = a_packed & 0xffff;
  int o = (a_packed >> 16) & 0xff;

  ivec4 mi = fetchMaster(m * 2);                        // rectStart, rectCount, w, h
  int localRect = gl_VertexID / 6;
  if (localRect >= mi.y) { discardVertex(); return; }   // surplus for this bucket

  int t = (mi.x + localRect) * 2;
  ivec4 g = fetchRect(t);                               // x, y, w, h (cell-local)
  ivec4 e = fetchRect(t + 1);                           // layer, flags, -, -
  if (layerHidden(e.x)) { discardVertex(); return; }

  int rx = g.x, ry = g.y, rw = g.z, rh = g.w;
  int W = mi.z, H = mi.w;
  int ox, oy, ow, oh;
  switch (o) {
    case 0:  ox = rx;          oy = ry;          ow = rw; oh = rh; break;  // N
    case 1:  ox = W - rx - rw; oy = H - ry - rh; ow = rw; oh = rh; break;  // S
    case 2:  ox = H - ry - rh; oy = rx;          ow = rh; oh = rw; break;  // W
    case 3:  ox = ry;          oy = W - rx - rw; ow = rh; oh = rw; break;  // E
    case 4:  ox = W - rx - rw; oy = ry;          ow = rw; oh = rh; break;  // FN
    case 5:  ox = rx;          oy = H - ry - rh; ow = rw; oh = rh; break;  // FS
    case 6:  ox = H - ry - rh; oy = W - rx - rw; ow = rh; oh = rw; break;  // FW
    default: ox = ry;          oy = rx;          ow = rh; oh = rw; break;  // FE
  }

  vec2 size = vec2(float(ow), float(oh));
  if (max(size.x, size.y) * u_scale < u_minPx) { discardVertex(); return; }

  int layer = e.x, ci = e.x;
  if (u_colorMode == 1) { int k = fetchMaster(m * 2 + 1).x; layer = classLayer(k); ci = 16 + k; }
  v_ci = ci; v_mode = 0; v_density = 1.0; v_fill = 0.0;
  v_alpha = u_layerAlpha[e.x];          // alpha follows the real layer, not the class
  int q = QI[gl_VertexID % 6];
  vec2 local = vec2(a_pos) + vec2(float(ox), float(oy));
  emitQuad(tinfo.xy, local, size, vec2(float(q & 1), float(q >> 1)), layer);
}`;

// Mid: one quad per placement, the master's bounding box. Never touches the
// rect table - outline w/h comes from the master table, which is resident.
const VS_MID = `#version 300 es
${COMMON}
layout(location=0) in ivec2 a_pos;
layout(location=1) in int   a_packed;
layout(location=2) in int   a_tileSlot;

void main() {
  if (a_packed < 0) { discardVertex(); return; }
  vec4 tinfo = tileEntry(a_tileSlot);
  if (tinfo.z < 0.0) { discardVertex(); return; }
  int m = a_packed & 0xffff;
  int o = (a_packed >> 16) & 0xff;
  ivec4 mi = fetchMaster(m * 2);
  bool rot = (o == 2 || o == 3 || o == 6 || o == 7);
  vec2 size = rot ? vec2(float(mi.w), float(mi.z)) : vec2(float(mi.z), float(mi.w));
  if (max(size.x, size.y) * u_scale < u_minPx) { discardVertex(); return; }

  int k = fetchMaster(m * 2 + 1).x;
  int layer = classLayer(k);
  if (layerHidden(layer)) { discardVertex(); return; }
  v_ci = u_colorMode == 1 ? 16 + k : layer;
  v_mode = 0; v_density = 1.0; v_fill = 0.0;
  v_alpha = u_layerAlpha[layer];
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  emitQuad(tinfo.xy, vec2(a_pos), size, corner, layer);
}`;

// Far: pre-merged blocks that already carry their own size and density.
const VS_FAR = `#version 300 es
${COMMON}
layout(location=0) in ivec2 a_pos;
layout(location=1) in ivec2 a_size;
layout(location=2) in float a_density;    // logic area fraction
layout(location=3) in int   a_layer;
layout(location=4) in int   a_tileSlot;
layout(location=5) in float a_fill;       // filler area fraction

void main() {
  if (a_layer < 0) { discardVertex(); return; }
  if (layerHidden(a_layer)) { discardVertex(); return; }
  vec4 tinfo = tileEntry(a_tileSlot);
  if (tinfo.z < 0.0) { discardVertex(); return; }
  vec2 size = vec2(a_size);
  if (max(size.x, size.y) * u_scale < u_minPx) { discardVertex(); return; }
  // A density block is coloured by what it holds, not by a palette entry: that
  // is the whole content of a far tile. Macros and the power grid stay flat and
  // sharp on top of it.
  v_mode = a_layer == ${LAYER_CELLBOX} ? 1 : 0;
  v_ci = u_colorMode == 1
       ? (a_layer == ${LAYER_MACROBOX} ? 17 : a_layer == ${LAYER_POWERBOX} ? 18 : 16)
       : a_layer;
  v_density = a_density;
  v_fill = a_fill;
  v_alpha = u_layerAlpha[a_layer];
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  emitQuad(tinfo.xy, vec2(a_pos), size, corner, a_layer);
}`;

// The full-die view lives or dies here.
//
// A single hue scaled by density is the grey mud the spike ran into: a design
// that runs 40-95% full spends its whole range in the top half of one ramp, and
// every region ends up the same colour. Two things fix it. The ramp walks hue
// as well as lightness, and it is stretched across the design's actual p5..p95
// logic density rather than [0, 1]. Then dead area is pulled out of the ramp
// entirely - a block packed with decaps is occupied but doing nothing, and
// showing it as "dense" is worse than not showing density at all.
const FS = `#version 300 es
precision mediump float;
flat in int v_ci;
flat in int v_mode;
in float v_density;
in float v_fill;
in float v_alpha;
uniform vec3 u_palette[${PALETTE_SIZE}];
uniform vec2 u_dens;
out vec4 o_color;

vec3 ramp(float t) {
  vec3 c0 = vec3(0.10, 0.14, 0.32);   // sparse
  vec3 c1 = vec3(0.13, 0.45, 0.56);
  vec3 c2 = vec3(0.42, 0.70, 0.36);
  vec3 c3 = vec3(0.88, 0.78, 0.32);
  vec3 c4 = vec3(0.90, 0.42, 0.22);   // packed
  if (t < 0.25) return mix(c0, c1, t * 4.0);
  if (t < 0.50) return mix(c1, c2, (t - 0.25) * 4.0);
  if (t < 0.75) return mix(c2, c3, (t - 0.50) * 4.0);
  return mix(c3, c4, (t - 0.75) * 4.0);
}

void main() {
  vec3 c;
  if (v_mode == 1) {
    float t = clamp((v_density - u_dens.x) / max(1e-4, u_dens.y - u_dens.x), 0.0, 1.0);
    c = ramp(t);
    float occupied = v_density + v_fill;
    float dead = occupied > 1e-4 ? v_fill / occupied : 0.0;
    c = mix(c, vec3(0.30, 0.29, 0.34), smoothstep(0.45, 0.90, dead));
  } else {
    c = u_palette[v_ci];
  }
  o_color = vec4(c, v_alpha);
}`;

// Debug overlay: tile bounds and content boxes as line loops.
const VS_LINES = `#version 300 es
precision highp float;
layout(location=0) in vec4 a_rect;    // dx, dy, w, h relative to the view origin
layout(location=1) in float a_kind;   // 0 = tile bounds, 1 = content box
uniform vec2 u_cam;
uniform float u_scale;
uniform vec2 u_res;
flat out int v_kind;
void main() {
  vec2 c = gl_VertexID == 0 ? vec2(0.0, 0.0)
         : gl_VertexID == 1 ? vec2(1.0, 0.0)
         : gl_VertexID == 2 ? vec2(1.0, 1.0) : vec2(0.0, 1.0);
  vec2 p = (a_rect.xy + c * a_rect.zw - u_cam) * u_scale + 0.5 * u_res;
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, -0.99, 1.0);
  v_kind = int(a_kind + 0.5);
}`;
const FS_LINES = `#version 300 es
precision mediump float;
flat in int v_kind;
out vec4 o_color;
void main() {
  o_color = v_kind == 0 ? vec4(0.25, 0.85, 0.95, 1.0)
          : v_kind == 1 ? vec4(0.95, 0.55, 0.20, 1.0)
          : v_kind == 2 ? vec4(0.55, 0.60, 0.70, 1.0)    // block instance outline
                        : vec4(1.00, 0.95, 0.35, 1.0);   // selection
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function link(gl, vs, fs, uniforms) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const U = {};
  for (const n of uniforms) U[n] = gl.getUniformLocation(p, n);
  return { prog: p, U };
}

const QUAD_U = ['u_cam', 'u_scale', 'u_res', 'u_minPx', 'u_palette',
                'u_masters', 'u_rects', 'u_tiles', 'u_layerMask', 'u_colorMode',
                'u_tileBase', 'u_rot', 'u_layerAlpha', 'u_dens'];

export class Renderer {
  constructor(gl, masters, caps) {
    this.gl = gl;
    this.masters = masters;
    // Shipped by the generator in manifest.bucketCaps. Deep tiles are sorted by
    // the bucket these imply, so they are data, never a local constant.
    this.caps = caps;
    // Checked because it is the obvious alternative to bucketing, and it is not
    // used: bucketing needs no extension, and it also fixes the *buffer* layout
    // (one contiguous pool per bucket), which multi-draw on its own would not.
    this.multiDraw = !!gl.getExtension('WEBGL_multi_draw');

    this.deep = link(gl, VS_DEEP, FS, QUAD_U);
    this.mid  = link(gl, VS_MID, FS, QUAD_U);
    this.far  = link(gl, VS_FAR, FS, QUAD_U);
    this.lines = link(gl, VS_LINES, FS_LINES, ['u_cam', 'u_scale', 'u_res']);
    for (const p of [this.deep, this.mid, this.far]) {
      gl.useProgram(p.prog);
      gl.uniform3fv(p.U.u_palette, PALETTE.flat());
      gl.uniform1i(p.U.u_masters, 0);
      gl.uniform1i(p.U.u_rects, 1);
      gl.uniform1i(p.U.u_tiles, 2);
    }

    this.masterTex = this._intTexture(masters.masters, masters.masterCount * 2);
    this.rectTex = this._intTexture(masters.rects, masters.rectCount * 2);
    this._buildTileTexture();

    // one pool per bucket for deep, one for mid, one for far
    this.deepPools = this.caps.map(() => new SlotPool(gl, PLACEMENT_SLOT_I32 * 4, 1 << 15));
    this.midPool = new SlotPool(gl, PLACEMENT_SLOT_I32 * 4, 1 << 16);
    this.farPool = new SlotPool(gl, BLOCK_SLOT_I32 * 4, 1 << 13);
    this.deepVaos = this.deepPools.map(p => this._placementVao(p));
    this.midVao = this._placementVao(this.midPool);
    this.farVao = this._farVao(this.farPool);

    this.lineBuf = gl.createBuffer();
    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, 0); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 16); gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0.055, 0.055, 0.065, 1);
    gl.clearDepth(1.0);

    // resident tile bookkeeping
    this.originX = 0;
    this.originY = 0;
    this.kind = TILE_KIND.FAR;
    this.resident = new Map();          // key -> { tile, tileSlot, allocs }
    this.freeTileSlots = [];
    for (let i = MAX_TILE_SLOTS - 1; i >= 0; i--) this.freeTileSlots.push(i);
    // Indexed (instance, tileSlot): instance i's entry for slot s is at
    // i * tileStride + s. The stride tracks the resident set rather than the
    // slot ceiling, so 70 instances of a one-tile block cost 70 entries.
    this.tileOrigins = new Float32Array(MAX_TILE_ENTRIES * 4);
    this.instances = [IDENTITY_INSTANCE];
    this.tileStride = 1;
    this.instancesDropped = 0;

    this.scratch = new Int32Array(1 << 16);
    // Layer visibility is a uniform and nothing else: toggling a layer changes
    // one integer, never a buffer. Hidden layers collapse their vertices in the
    // vertex shader rather than discarding fragments, so a hidden layer costs
    // no rasterisation at all.
    this.layerMask = 0xffff;
    // Per-layer alpha. All 1.0 is the opaque path, which is the fast one; any
    // value below 1 switches drawing to ordered per-layer passes (see draw).
    this.layerAlpha = new Float32Array(16).fill(1);
    this.translucent = false;
    this.densityRange = [0, 1];
    this.blockSize = 0;
    this.blockBounds = false;
    // What was clicked, as a chip-space rect. A panel that describes a cell
    // without showing which one it is leaves the reader counting rows.
    this.selectionBox = null;
    this.colorMode = 0;
    this.showTiles = false;
    this.minPx = 0;

    // stats
    this.instanceCount = 0;
    this.rectCount = 0;
    this.submittedRects = 0;
    this.distinctMasters = 0;
    this.drawCalls = 0;
    this.updateMs = 0;
    this.updateWorstMs = 0;
    this.updates = 0;
    this.lastAdded = 0;
    this.lastRemoved = 0;
    // Per-master reference counts, so the distinct-master figure is maintained
    // as tiles come and go. Recounting every placement on each tile arrival
    // would cost more than loading the tile.
    this._refs = new Int32Array(masters.masterCount);
  }

  // masters.bin's tables go to the GPU untouched apart from padding the last
  // texture row: 8 int32 per record == 2 RGBA32I texels.
  _intTexture(src, texels) {
    const gl = this.gl;
    const rows = Math.max(1, Math.ceil(texels / RECT_TEX_WIDTH));
    const padded = new Int32Array(RECT_TEX_WIDTH * rows * 4);
    padded.set(src);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32I, RECT_TEX_WIDTH, rows, 0,
                  gl.RGBA_INTEGER, gl.INT, padded);
    return { tex, bytes: padded.byteLength, rows };
  }

  _buildTileTexture() {
    const gl = this.gl;
    const rows = MAX_TILE_ENTRIES / TILE_TEX_WIDTH;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TILE_TEX_WIDTH, rows, 0,
                  gl.RGBA, gl.FLOAT, new Float32Array(MAX_TILE_ENTRIES * 4));
    this.tileTex = tex;
    this.tileTexRows = rows;
  }

  _placementVao(pool) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, pool.buf);
    const s = PLACEMENT_SLOT_I32 * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0, 2, gl.INT, s, 0);  gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 1, gl.INT, s, 8);  gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 1, gl.INT, s, 12); gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
    return { vao, generation: pool.generation || 0 };
  }

  _farVao(pool) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, pool.buf);
    const s = BLOCK_SLOT_I32 * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0, 2, gl.INT, s, 0);  gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 2, gl.INT, s, 8);  gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, s, 16); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 1, gl.INT, s, 20); gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribIPointer(4, 1, gl.INT, s, 28); gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, s, 24); gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);
    return { vao, generation: pool.generation || 0 };
  }

  // A pool that grew has a new buffer object, so its VAO must re-point.
  _syncVao(entry, pool, isFar) {
    if ((pool.generation || 0) === entry.generation) return entry;
    this.gl.deleteVertexArray(entry.vao);
    const next = isFar ? this._farVao(pool) : this._placementVao(pool);
    entry.vao = next.vao;
    entry.generation = next.generation;
    return entry;
  }

  needsResnap(cam) {
    const drift = Math.max(Math.abs(cam.x - this.originX), Math.abs(cam.y - this.originY));
    return drift * cam.scale > 1e6;
  }

  _scratchFor(i32) {
    if (this.scratch.length < i32) this.scratch = new Int32Array(Math.ceil(i32 * 1.25));
    return this.scratch;
  }

  // ------------------------------------------------------------ residency
  // Entering and leaving tiles touch only their own slots.

  _addTile(key, tile) {
    const tileSlot = this.freeTileSlots.pop();
    if (tileSlot === undefined) return false;
    const allocs = [];

    if (tile.kind === TILE_KIND.FAR) {
      const n = tile.count;
      const out = this._scratchFor(n * BLOCK_SLOT_I32);
      buildBlockSlots(tile, tileSlot, out);
      const off = this.farPool.alloc(n);
      this.farPool.write(off, out.subarray(0, n * BLOCK_SLOT_I32));
      allocs.push({ pool: this.farPool, off, n, far: true });
    } else if (tile.kind === TILE_KIND.MID) {
      const n = tile.count;
      const out = this._scratchFor(n * PLACEMENT_SLOT_I32);
      buildPlacementSlots(tile, 0, n, tileSlot, out);
      const off = this.midPool.alloc(n);
      this.midPool.write(off, out.subarray(0, n * PLACEMENT_SLOT_I32));
      allocs.push({ pool: this.midPool, off, n });
    } else {
      for (const b of tileBuckets(tile)) {
        const out = this._scratchFor(b.count * PLACEMENT_SLOT_I32);
        buildPlacementSlots(tile, b.start, b.count, tileSlot, out);
        const pool = this.deepPools[b.bucket];
        const off = pool.alloc(b.count);
        pool.write(off, out.subarray(0, b.count * PLACEMENT_SLOT_I32));
        allocs.push({ pool, off, n: b.count });
      }
    }

    this.resident.set(key, { tile, tileSlot, allocs });
    this._account(tile, 1);
    return true;
  }

  _removeTile(key) {
    const r = this.resident.get(key);
    if (!r) return;
    for (const a of r.allocs) {
      const words = a.far ? BLOCK_SLOT_I32 : PLACEMENT_SLOT_I32;
      const out = this._scratchFor(a.n * words);
      if (a.far) fillFreeBlocks(out, a.n); else fillFreePlacements(out, a.n);
      a.pool.write(a.off, out.subarray(0, a.n * words));
      a.pool.release(a.off, a.n);
    }
    this._account(r.tile, -1);
    this.freeTileSlots.push(r.tileSlot);
    this.resident.delete(key);
  }

  // Fold one tile into (sign +1) or out of (sign -1) the running totals.
  _account(t, sign) {
    this.instanceCount += sign * t.count;
    this.rectCount += sign * t.rectCount;
    if (t.kind === TILE_KIND.FAR) { this.submittedRects += sign * t.count; return; }
    if (t.kind === TILE_KIND.MID) this.submittedRects += sign * t.count;
    else for (const b of tileBuckets(t)) this.submittedRects += sign * b.count * this.caps[b.bucket];
    const refs = this._refs;
    for (let i = 0; i < t.count; i++) {
      const m = t.inst[i * I_STRIDE + 2] & 0xffff;
      const before = refs[m];
      refs[m] = before + sign;
      if (sign > 0 && before === 0) this.distinctMasters++;
      else if (sign < 0 && before === 1) this.distinctMasters--;
    }
  }

  // Reconcile the resident set with what should be visible. `wanted` is a Map
  // of key -> tile view, all of the same kind, deduplicated across block
  // instances: a tile shared by 70 instances is one entry, one slot, one fetch.
  // `instances` is what to draw it as, each { m, tx, ty, keys }.
  setVisible(wanted, cam, instances) {
    const t0 = performance.now();
    const resnap = this.needsResnap(cam) || this.resident.size === 0;
    if (resnap) { this.originX = cam.x; this.originY = cam.y; }

    let kind = this.kind;
    for (const t of wanted.values()) { kind = t.kind; break; }
    const kindChanged = kind !== this.kind;
    this.kind = kind;

    let removed = 0;
    for (const key of [...this.resident.keys()]) {
      if (kindChanged || !wanted.has(key)) { this._removeTile(key); removed++; }
    }
    let added = 0;
    for (const [key, tile] of wanted) {
      if (this.resident.has(key)) continue;
      if (this._addTile(key, tile)) added++;
    }

    // Only the per-tile origin table depends on the view origin or on where the
    // instances sit, and it is a few kilobytes. Nothing in the slot buffers is
    // origin-relative or instance-relative, which is what makes drawing the
    // same tile N times cost N uniforms rather than N copies.
    this._writeTileTable(instances || this.instances);

    this.updates++;
    this.lastAdded = added;
    this.lastRemoved = removed;
    this.updateMs = performance.now() - t0;
    if (this.updateMs > this.updateWorstMs) this.updateWorstMs = this.updateMs;
    return { added, resnap };
  }

  // One entry per (instance, resident tile): the tile's origin transformed into
  // chip space and made relative to the view origin, in f64 here so the shader
  // only ever sees small numbers. z carries whether this tile is in this
  // instance's own visible set - a tile resident for a neighbour is skipped
  // rather than drawn off-screen.
  _writeTileTable(instances) {
    let maxSlot = 0;
    for (const r of this.resident.values()) if (r.tileSlot > maxSlot) maxSlot = r.tileSlot;
    const stride = maxSlot + 1;

    // Rail, not a policy: the ladder refuses levels long before this, and the
    // alternative to dropping the furthest instances is corrupting the table.
    let list = instances;
    if (list.length * stride > MAX_TILE_ENTRIES) {
      list = list.slice(0, Math.max(1, Math.floor(MAX_TILE_ENTRIES / stride)));
    }
    this.instancesDropped = instances.length - list.length;
    this.instances = list;
    this.tileStride = stride;

    for (let i = 0; i < list.length; i++) {
      const inst = list[i], m = inst.m, base = (i * stride) * 4;
      for (const [key, r] of this.resident) {
        const e = base + r.tileSlot * 4;
        const ox = r.tile.originX, oy = r.tile.originY;
        this.tileOrigins[e]     = m[0] * ox + m[2] * oy + inst.tx - this.originX;
        this.tileOrigins[e + 1] = m[1] * ox + m[3] * oy + inst.ty - this.originY;
        this.tileOrigins[e + 2] = !inst.keys || inst.keys.has(key) ? 1 : -1;
      }
    }

    const rows = Math.min(this.tileTexRows, Math.ceil(list.length * stride / TILE_TEX_WIDTH));
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE_TEX_WIDTH, Math.max(1, rows),
                     gl.RGBA, gl.FLOAT, this.tileOrigins);
  }

  get pools() {
    return this.kind === TILE_KIND.DEEP ? this.deepPools
         : this.kind === TILE_KIND.MID ? [this.midPool] : [this.farPool];
  }

  get poolBytes() {
    let b = 0;
    for (const p of [...this.deepPools, this.midPool, this.farPool]) b += p.bytes;
    return b;
  }

  get waste() {
    let hw = 0, used = 0;
    for (const p of this.pools) { hw += p.highWater; used += p.used; }
    return hw === 0 ? 0 : 1 - used / hw;
  }

  // ------------------------------------------------------------ draw
  //
  // Two paths. Opaque is the default and the fast one: one pass, the depth test
  // doing all the layer ordering, hidden layers collapsed in the vertex shader.
  //
  // Translucent is what per-layer alpha needs, and it needs the layers
  // submitted bottom-up with depth writes off, because blending is
  // order-dependent and the depth key cannot order what it is not writing. That
  // is the constraint documented under "Rendering is opaque-only": the cost of
  // lifting it is one pass per visible layer, so draw calls go from
  // (buckets x instances) to (layers x buckets x instances). Worth paying only
  // when someone has actually asked to see through the stack.
  draw(cam) {
    const gl = this.gl;
    gl.viewport(0, 0, cam.resW, cam.resH);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.masterTex.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.rectTex.tex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.tileTex);

    const camX = cam.x - this.originX, camY = cam.y - this.originY;
    const setup = (p, mask) => {
      gl.useProgram(p.prog);
      gl.uniform2f(p.U.u_cam, camX, camY);
      gl.uniform1f(p.U.u_scale, cam.scale);
      gl.uniform2f(p.U.u_res, cam.resW, cam.resH);
      gl.uniform1f(p.U.u_minPx, this.minPx);
      gl.uniform1i(p.U.u_layerMask, mask);
      gl.uniform1i(p.U.u_colorMode, this.colorMode);
      gl.uniform1fv(p.U.u_layerAlpha, this.layerAlpha);
      gl.uniform2f(p.U.u_dens, this.densityRange[0], this.densityRange[1]);
    };

    let calls = 0;
    if (this.translucent) {
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (const layer of this.layerPasses()) calls += this._drawSet(setup, 1 << layer);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    } else {
      calls += this._drawSet(setup, this.layerMask);
    }

    if (this.selectionBox) calls += this._drawSelection(cam, camX, camY);
    if (this.blockBounds && this.instances.length > 1) calls += this._drawBlockBounds(cam, camX, camY);
    if (this.showTiles) calls += this._drawTileBounds(cam, camX, camY);

    gl.bindVertexArray(null);
    this.drawCalls = calls;
    return calls;
  }

  // Visible layers for the resident kind, bottom-up. Deep tiles carry real
  // process layers; mid and far carry the three abstract ones.
  layerPasses() {
    const lo = this.kind === TILE_KIND.DEEP ? 0 : LAYER_CELLBOX;
    const hi = this.kind === TILE_KIND.DEEP ? LAYER_CELLBOX - 1 : LAYER_POWERBOX;
    const out = [];
    for (let l = lo; l <= hi; l++) if ((this.layerMask >> l) & 1) out.push(l);
    return out;
  }

  // One pass over everything resident, under one layer mask: the same slots,
  // once per visible block instance.
  _drawSet(setup, mask) {
    const gl = this.gl;
    let calls = 0;
    const perInstance = (p, body) => {
      setup(p, mask);
      for (let i = 0; i < this.instances.length; i++) {
        const inst = this.instances[i];
        gl.uniform1i(p.U.u_tileBase, i * this.tileStride);
        gl.uniform4f(p.U.u_rot, inst.m[0], inst.m[1], inst.m[2], inst.m[3]);
        body();
      }
    };

    if (this.kind === TILE_KIND.DEEP) {
      perInstance(this.deep, () => {
        for (let b = 0; b < this.deepPools.length; b++) {
          const pool = this.deepPools[b];
          if (pool.highWater === 0) continue;
          const entry = this._syncVao(this.deepVaos[b], pool, false);
          gl.bindVertexArray(entry.vao);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, this.caps[b] * 6, pool.highWater);
          calls++;
        }
      });
    } else if (this.kind === TILE_KIND.MID) {
      if (this.midPool.highWater > 0) {
        perInstance(this.mid, () => {
          const entry = this._syncVao(this.midVao, this.midPool, false);
          gl.bindVertexArray(entry.vao);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.midPool.highWater);
          calls++;
        });
      }
    } else if (this.farPool.highWater > 0) {
      perInstance(this.far, () => {
        const entry = this._syncVao(this.farVao, this.farPool, true);
        gl.bindVertexArray(entry.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.farPool.highWater);
        calls++;
      });
    }
    return calls;
  }

  // The selected placement or density block, as one line loop.
  _drawSelection(cam, camX, camY) {
    const gl = this.gl;
    const s = this.selectionBox;
    const data = new Float32Array([
      s.x - this.originX, s.y - this.originY, s.w, s.h, 3,
    ]);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.useProgram(this.lines.prog);
    gl.uniform2f(this.lines.U.u_cam, camX, camY);
    gl.uniform1f(this.lines.U.u_scale, cam.scale);
    gl.uniform2f(this.lines.U.u_res, cam.resW, cam.resH);
    gl.drawArraysInstanced(gl.LINE_LOOP, 0, 4, 1);
    return 1;
  }

  // Block instance outlines. At chip zoom the blocks are the structure - where
  // one ends and the next begins is the first thing to read off the view - and
  // one line loop per instance is cheaper than any of the alternatives.
  _drawBlockBounds(cam, camX, camY) {
    const gl = this.gl;
    const n = this.instances.length;
    if (n === 0 || this.blockSize === 0) return 0;
    const S = this.blockSize;
    const data = new Float32Array(n * 5);
    let w = 0;
    for (const inst of this.instances) {
      const m = inst.m;
      const xs = [], ys = [];
      for (const [x, y] of [[0, 0], [S, 0], [0, S], [S, S]]) {
        xs.push(m[0] * x + m[2] * y + inst.tx - this.originX);
        ys.push(m[1] * x + m[3] * y + inst.ty - this.originY);
      }
      data[w] = Math.min(...xs); data[w + 1] = Math.min(...ys);
      data[w + 2] = Math.max(...xs) - Math.min(...xs);
      data[w + 3] = Math.max(...ys) - Math.min(...ys);
      data[w + 4] = 2; w += 5;
    }
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.useProgram(this.lines.prog);
    gl.uniform2f(this.lines.U.u_cam, camX, camY);
    gl.uniform1f(this.lines.U.u_scale, cam.scale);
    gl.uniform2f(this.lines.U.u_res, cam.resW, cam.resH);
    gl.drawArraysInstanced(gl.LINE_LOOP, 0, 4, n);
    return 1;
  }

  _drawTileBounds(cam, camX, camY) {
    const gl = this.gl;
    const n = this.resident.size * this.instances.length;
    if (n === 0) return 0;
    const data = new Float32Array(n * 2 * 5);
    let w = 0;
    // Boxes are axis-aligned under every orientation, so the transform is two
    // corners and a min/max rather than a rotated outline.
    for (const inst of this.instances) {
      const m = inst.m;
      const put = (x0, y0, x1, y1, kind) => {
        const ax = m[0] * x0 + m[2] * y0 + inst.tx - this.originX;
        const ay = m[1] * x0 + m[3] * y0 + inst.ty - this.originY;
        const bx = m[0] * x1 + m[2] * y1 + inst.tx - this.originX;
        const by = m[1] * x1 + m[3] * y1 + inst.ty - this.originY;
        data[w] = Math.min(ax, bx); data[w + 1] = Math.min(ay, by);
        data[w + 2] = Math.abs(bx - ax); data[w + 3] = Math.abs(by - ay);
        data[w + 4] = kind; w += 5;
      };
      for (const [key, r] of this.resident) {
        if (inst.keys && !inst.keys.has(key)) { w += 10; continue; }
        const t = r.tile;
        put(t.originX, t.originY, t.originX + t.tileSize, t.originY + t.tileSize, 0);
        put(t.originX + t.minX, t.originY + t.minY,
            t.originX + t.maxX, t.originY + t.maxY, 1);
      }
    }
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.useProgram(this.lines.prog);
    gl.uniform2f(this.lines.U.u_cam, camX, camY);
    gl.uniform1f(this.lines.U.u_scale, cam.scale);
    gl.uniform2f(this.lines.U.u_res, cam.resW, cam.resH);
    gl.drawArraysInstanced(gl.LINE_LOOP, 0, 4, n * 2);
    return 1;
  }
}
