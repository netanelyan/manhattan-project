// WebGL2 instanced renderer.
//
// Geometry lives in an RGBA32I texture built once from masters.bin: two texels
// per rectangle, addressed by rect index. A draw call says "master m, rect
// range [base, base+count), N instances" and the vertex shader expands
// gl_VertexID into rect index + quad corner, fetching the rect from the
// texture. No per-master vertex buffers, no CPU-side geometry expansion.
//
// Per-instance data is a single staging buffer holding every visible instance
// grouped by master, so one draw call covers a master across all visible tiles.
// The staging buffer is rebuilt only when the visible tile set, the LOD level
// or the view origin changes - never on a plain pan or zoom.
//
// Local origin fix: staging holds (instanceWorld - viewOrigin) computed in f64
// on the CPU and stored as f32. viewOrigin tracks the camera, so the f32 values
// stay small no matter how deep the zoom goes.

import { RECT_TEX_WIDTH, M_STRIDE, M_RECT_START, M_RECT_COUNT, M_W, M_H,
         G_STRIDE, G_MASTER, G_START, G_COUNT, I_STRIDE } from './format.js';

// Layer palette, indexed by the layer id stored in each rect.
export const LAYER_NAMES = [
  'outline', 'nwell', 'diff', 'poly', 'contact', 'metal1',
  'via1', 'metal2', 'metal3', 'pin', 'macro', 'power',
];
const PALETTE = [
  [0.23, 0.23, 0.27], [0.16, 0.18, 0.23], [0.18, 0.42, 0.31], [0.69, 0.29, 0.29],
  [0.85, 0.85, 0.85], [0.24, 0.44, 0.72], [0.81, 0.81, 0.38], [0.72, 0.40, 0.24],
  [0.48, 0.31, 0.72], [0.88, 0.75, 0.25], [0.29, 0.29, 0.35], [0.78, 0.31, 0.24],
  [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
];

const LOG2_TEXW = Math.log2(RECT_TEX_WIDTH) | 0;

const VS = `#version 300 es
precision highp float;
precision highp int;

layout(location=0) in vec2  a_delta;    // instance origin minus view origin, nm
layout(location=1) in float a_orient;   // LEF orientation 0..7

uniform highp isampler2D u_rects;
uniform int   u_rectBase;   // first rect of this master
uniform ivec2 u_bbox;       // master bounding box, nm
uniform vec2  u_cam;        // camera centre minus view origin, nm
uniform float u_scale;      // device px per nm
uniform vec2  u_res;        // device px
uniform float u_minPx;      // drop rects smaller than this on screen

flat out int v_layer;

const int QI[6] = int[6](0, 1, 2, 2, 1, 3);

ivec4 fetchRect(int i) {
  return texelFetch(u_rects, ivec2(i & ${RECT_TEX_WIDTH - 1}, i >> ${LOG2_TEXW}), 0);
}

void main() {
  int t = (u_rectBase + gl_VertexID / 6) * 2;
  ivec4 g = fetchRect(t);        // x, y, w, h  (cell-local nm)
  ivec4 e = fetchRect(t + 1);    // layer, flags, -, -

  int rx = g.x, ry = g.y, rw = g.z, rh = g.w;
  int W = u_bbox.x, H = u_bbox.y;
  int ox, oy, ow, oh;
  switch (int(a_orient + 0.5)) {
    case 0:  ox = rx;          oy = ry;          ow = rw; oh = rh; break;  // N
    case 1:  ox = W - rx - rw; oy = H - ry - rh; ow = rw; oh = rh; break;  // S
    case 2:  ox = H - ry - rh; oy = rx;          ow = rh; oh = rw; break;  // W
    case 3:  ox = ry;          oy = W - rx - rw; ow = rh; oh = rw; break;  // E
    case 4:  ox = W - rx - rw; oy = ry;          ow = rw; oh = rh; break;  // FN
    case 5:  ox = rx;          oy = H - ry - rh; ow = rw; oh = rh; break;  // FS
    case 6:  ox = H - ry - rh; oy = W - rx - rw; ow = rh; oh = rw; break;  // FW
    default: ox = ry;          oy = rx;          ow = rh; oh = rw; break;  // FE
  }

  float fw = float(ow), fh = float(oh);
  if (max(fw, fh) * u_scale < u_minPx) {
    gl_Position = vec4(0.0, 0.0, 0.0, -1.0);   // collapse behind the near plane
    return;
  }

  int q = QI[gl_VertexID % 6];
  vec2 corner = vec2(float(q & 1), float(q >> 1));
  vec2 world = a_delta + vec2(float(ox), float(oy)) + corner * vec2(fw, fh);
  vec2 px = (world - u_cam) * u_scale + 0.5 * u_res;

  // Layer index doubles as a depth key, so metal draws over poly draws over
  // diffusion without sorting the draw calls.
  float z = 1.0 - float(e.x) * (1.0 / 16.0);
  gl_Position = vec4(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0, z, 1.0);
  v_layer = e.x;
}`;

const FS = `#version 300 es
precision mediump float;
flat in int v_layer;
uniform vec3 u_palette[16];
out vec4 o_color;
void main() { o_color = vec4(u_palette[v_layer], 1.0); }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
  }
  return s;
}

export class Renderer {
  constructor(gl, masters) {
    this.gl = gl;
    this.masters = masters;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    gl.useProgram(prog);

    this.U = {};
    for (const n of ['u_rects', 'u_rectBase', 'u_bbox', 'u_cam', 'u_scale',
                     'u_res', 'u_minPx', 'u_palette']) {
      this.U[n] = gl.getUniformLocation(prog, n);
    }
    gl.uniform3fv(this.U.u_palette, PALETTE.flat());
    gl.uniform1i(this.U.u_rects, 0);

    this._buildRectTexture();

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribDivisor(0, 1);
    gl.vertexAttribDivisor(1, 1);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0.055, 0.055, 0.065, 1);
    gl.clearDepth(1.0);

    // View origin for the f32 delta trick, plus the staging buffer.
    this.originX = 0;
    this.originY = 0;
    this.staging = new Float32Array(0);
    this.batches = [];        // { master, first, count, rects }
    this.instanceCount = 0;
    this.rectCount = 0;
    this.rebuilds = 0;
    this.lastRebuildMs = 0;
  }

  // masters.bin's rect table goes to the GPU untouched apart from padding the
  // last texture row: 8 int32 per rect == 2 RGBA32I texels.
  _buildRectTexture() {
    const gl = this.gl;
    const texels = this.masters.rectCount * 2;
    const rows = Math.max(1, Math.ceil(texels / RECT_TEX_WIDTH));
    const padded = new Int32Array(RECT_TEX_WIDTH * rows * 4);
    padded.set(this.masters.rects);

    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32I, RECT_TEX_WIDTH, rows, 0,
                  gl.RGBA_INTEGER, gl.INT, padded);
    this.rectTex = tex;
    this.rectTexBytes = padded.byteLength;
  }

  // Should the origin be re-snapped? Once the camera has drifted far enough
  // that the f32 deltas would start losing subpixel precision, resnap.
  needsResnap(cam) {
    const drift = Math.max(Math.abs(cam.x - this.originX), Math.abs(cam.y - this.originY));
    return drift * cam.scale > 1e6;
  }

  // Rebuild the staging buffer from a list of loaded instance tiles. Instances
  // are concatenated grouped by master so each master needs exactly one draw
  // call regardless of how many tiles contribute to it.
  setVisible(tiles, cam) {
    const t0 = performance.now();
    const gl = this.gl;
    const nM = this.masters.masterCount;
    const md = this.masters.masters;

    this.originX = cam.x;
    this.originY = cam.y;

    let total = 0, rectTotal = 0;
    const totals = new Int32Array(nM + 1);
    for (const t of tiles) {
      for (let g = 0; g < t.groupCount; g++) {
        const b = g * G_STRIDE;
        totals[t.groups[b + G_MASTER] + 1] += t.groups[b + G_COUNT];
      }
      total += t.count;
      rectTotal += t.rectCount;
    }
    for (let m = 0; m < nM; m++) totals[m + 1] += totals[m];

    if (this.staging.length < total * 3) {
      this.staging = new Float32Array(Math.ceil(total * 1.25) * 3);
    }
    const st = this.staging;
    const cursor = totals.slice(0, nM);

    const batches = [];
    for (let m = 0; m < nM; m++) {
      const c = totals[m + 1] - totals[m];
      if (c === 0) continue;
      batches.push({
        master: m,
        first: totals[m],
        count: c,
        rectBase: md[m * M_STRIDE + M_RECT_START],
        rects: md[m * M_STRIDE + M_RECT_COUNT],
        w: md[m * M_STRIDE + M_W],
        h: md[m * M_STRIDE + M_H],
      });
    }

    for (const t of tiles) {
      // f64 subtraction happens here, once per instance, and only the small
      // difference is narrowed to f32.
      const dx = t.originX - this.originX;
      const dy = t.originY - this.originY;
      const inst = t.inst;
      for (let g = 0; g < t.groupCount; g++) {
        const b = g * G_STRIDE;
        const m = t.groups[b + G_MASTER];
        const s = t.groups[b + G_START];
        const c = t.groups[b + G_COUNT];
        let w = cursor[m] * 3;
        cursor[m] += c;
        for (let i = s, end = s + c; i < end; i++) {
          const p = i * I_STRIDE;
          st[w    ] = dx + inst[p];
          st[w + 1] = dy + inst[p + 1];
          st[w + 2] = (inst[p + 2] >>> 16) & 0xff;
          w += 3;
        }
      }
    }

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, st.subarray(0, total * 3), gl.DYNAMIC_DRAW);

    this.batches = batches;
    this.instanceCount = total;
    this.rectCount = rectTotal;
    this.rebuilds++;
    this.lastRebuildMs = performance.now() - t0;
  }

  draw(cam, minPx) {
    const gl = this.gl;
    gl.viewport(0, 0, cam.resW, cam.resH);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.batches.length === 0) return 0;

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.rectTex);

    gl.uniform2f(this.U.u_cam, cam.x - this.originX, cam.y - this.originY);
    gl.uniform1f(this.U.u_scale, cam.scale);
    gl.uniform2f(this.U.u_res, cam.resW, cam.resH);
    gl.uniform1f(this.U.u_minPx, minPx);

    let calls = 0;
    for (const b of this.batches) {
      const off = b.first * 12;
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, off);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, off + 8);
      gl.uniform1i(this.U.u_rectBase, b.rectBase);
      gl.uniform2i(this.U.u_bbox, b.w, b.h);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, b.rects * 6, b.count);
      calls++;
    }
    return calls;
  }
}
