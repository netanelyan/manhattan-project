'use strict';
// Synthetic chip layout generator: master library + structured placement.
// Pure data production, no I/O. Integer nanometre coordinates throughout.

// ---------------------------------------------------------------- constants
const ROW_H  = 1000;   // nm, standard cell row height (site height)
const SITE_W = 200;    // nm, placement grid pitch
const DBU_PER_MICRON = 1000;

const N_STD   = 390;   // standard cell masters
const N_MACRO = 6;     // memory macro masters
const N_PWR   = 4;     // power strap segment masters
                       // 400 masters total

const PWR_PITCH = 50000;        // nm between power straps, both directions
const PWR_SEG   = 25000;        // nm length of one strap segment master
const MACRO_AREA_FRAC = 0.12;   // fraction of die area consumed by macros

// Layer ids. The viewer's palette and the depth-sort key both index this.
const L = {
  OUTLINE: 0, NWELL: 1, DIFF: 2, POLY: 3, CONT: 4, METAL1: 5,
  VIA1: 6, METAL2: 7, METAL3: 8, PIN: 9, MACRO: 10, PWR: 11,
};

// Cell master classes.
const K = { STD: 0, MACRO: 1, PWR: 2 };

// LEF orientations.
const O = { N: 0, S: 1, W: 2, E: 3, FN: 4, FS: 5, FW: 6, FE: 7 };

// ---------------------------------------------------------------- prng
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- density field
// Two octaves of bilinear value noise, mapped to [lo, hi]. This is what makes
// some regions 95% full and others 40% - the "structure, not noise" requirement.
function makeDensityField(rand, lo, hi) {
  const G1 = 6, G2 = 13;
  const g1 = new Float64Array((G1 + 1) * (G1 + 1));
  const g2 = new Float64Array((G2 + 1) * (G2 + 1));
  for (let i = 0; i < g1.length; i++) g1[i] = rand();
  for (let i = 0; i < g2.length; i++) g2[i] = rand();

  const smooth = t => t * t * (3 - 2 * t);
  function octave(g, G, u, v) {
    const fu = Math.min(G - 1e-9, u * G), fv = Math.min(G - 1e-9, v * G);
    const i0 = fu | 0, j0 = fv | 0;
    const tu = smooth(fu - i0), tv = smooth(fv - j0);
    const s = G + 1;
    const a = g[j0 * s + i0],       b = g[j0 * s + i0 + 1];
    const c = g[(j0 + 1) * s + i0], d = g[(j0 + 1) * s + i0 + 1];
    return (a + (b - a) * tu) * (1 - tv) + (c + (d - c) * tu) * tv;
  }

  const raw = (u, v) => 0.72 * octave(g1, G1, u, v) + 0.28 * octave(g2, G2, u, v);

  // Numerically integrate so the caller can size the die analytically.
  let acc = 0;
  const S = 64;
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) acc += raw((i + 0.5) / S, (j + 0.5) / S);
  const meanRaw = acc / (S * S);

  const f = (u, v) => lo + (hi - lo) * raw(u, v);
  f.mean = lo + (hi - lo) * meanRaw;
  return f;
}

// ---------------------------------------------------------------- masters
// A master is a list of rectangles in cell-local nm. This is what gets
// instanced: ~400 unique shapes for millions of placements.

function pushRect(rects, x, y, w, h, layer, flags) {
  rects.push(x, y, w, h, layer, flags | 0, 0, 0);
}

// Standard cell: power rails top and bottom, two diffusion strips, poly gates
// crossing them, contacts, local metal1, pins. Rect count scales with width,
// landing in the 10..48 band.
function buildStdCell(rects, w) {
  const start = rects.length / 8;
  const h = ROW_H;
  const railH = 120;
  pushRect(rects, 0, 0, w, railH, L.METAL1, 0);
  pushRect(rects, 0, h - railH, w, railH, L.METAL1, 0);
  // NMOS strip is narrower than PMOS, as in a real cell. The asymmetry is also
  // what makes the N/FS row flip visible - a symmetric cell would render
  // identically either way and the orientation path would go untested.
  pushRect(rects, 60, 180, w - 120, 210, L.DIFF, 0);
  pushRect(rects, 60, 520, w - 120, 310, L.DIFF, 0);

  const nG = Math.max(1, Math.min(10, Math.floor((w - 200) / 400)));
  for (let k = 0; k < nG; k++) {
    const gx = 160 + k * 400;
    if (gx + 100 > w - 40) break;
    pushRect(rects, gx, 150, 100, 700, L.POLY, 0);
    pushRect(rects, gx - 90, 250, 70, 70, L.CONT, 0);
    pushRect(rects, gx - 90, 640, 70, 70, L.CONT, 0);
    pushRect(rects, gx - 100, 420, 260, 90, L.METAL1, 0);
  }
  const nPin = nG > 2 ? 4 : 2;
  const pitch = Math.max(200, Math.floor((w - 300) / nPin));
  for (let k = 0; k < nPin; k++) {
    const px = 120 + k * pitch;
    if (px + 120 > w) break;
    pushRect(rects, px, 430, 120, 120, L.PIN, 1);
  }
  return { rectStart: start, rectCount: rects.length / 8 - start, w, h, klass: K.STD, rowH: ROW_H };
}

// Memory macro: a solid body plus internal banks, a power ring and edge pins.
// Visually a solid block, which is the point - macros are the largest visible
// structure at coarse zoom.
function buildMacro(rects, w, h) {
  const start = rects.length / 8;
  pushRect(rects, 0, 0, w, h, L.MACRO, 0);
  const ring = Math.max(SITE_W, Math.round(h * 0.02 / SITE_W) * SITE_W);
  pushRect(rects, 0, 0, w, ring, L.PWR, 0);
  pushRect(rects, 0, h - ring, w, ring, L.PWR, 0);
  pushRect(rects, 0, 0, ring, h, L.PWR, 0);
  pushRect(rects, w - ring, 0, ring, h, L.PWR, 0);
  const bx = 4, by = 2;
  const cw = w - ring * 2, ch = h - ring * 2;
  const iw = Math.floor(cw / bx * 0.86), ih = Math.floor(ch / by * 0.86);
  for (let j = 0; j < by; j++)
    for (let i = 0; i < bx; i++)
      pushRect(rects,
        ring + Math.floor(cw * i / bx) + Math.floor(iw * 0.08),
        ring + Math.floor(ch * j / by) + Math.floor(ih * 0.08),
        iw, ih, L.METAL2, 0);
  const nPin = 16;
  const pw = Math.max(SITE_W, Math.floor(w / (nPin * 3)));
  for (let k = 0; k < nPin; k++)
    pushRect(rects,
      ring + Math.floor(cw * (k + 0.5) / nPin) - (pw >> 1),
      Math.floor(h * 0.5), pw, Math.max(SITE_W, Math.floor(h * 0.04)), L.PIN, 1);
  return { rectStart: start, rectCount: rects.length / 8 - start, w, h, klass: K.MACRO, rowH: 0 };
}

function buildStrap(rects, w, h) {
  const start = rects.length / 8;
  pushRect(rects, 0, 0, w, h, L.PWR, 0);
  return { rectStart: start, rectCount: 1, w, h, klass: K.PWR, rowH: 0 };
}

// ---------------------------------------------------------------- generate
function generate(opts) {
  const t0 = Date.now();
  const rand = mulberry32(opts.seed);
  const rects = [];
  const masters = [];

  // --- standard cell library. Widths 400..4000nm on the 200nm site grid.
  // Usage frequency is skewed small: inverters and NANDs dominate a real design.
  const stdWeights = new Float64Array(N_STD);
  for (let i = 0; i < N_STD; i++) {
    const sites = 2 + Math.floor(Math.pow(rand(), 1.9) * 19);   // 2..20 sites
    masters.push(buildStdCell(rects, sites * SITE_W));
    stdWeights[i] = 1 / (sites * sites * 0.35 + 1);
  }
  let wsum = 0;
  for (let i = 0; i < N_STD; i++) wsum += stdWeights[i];
  const stdCdf = new Float64Array(N_STD);
  let acc = 0, meanW = 0, meanRects = 0;
  for (let i = 0; i < N_STD; i++) {
    const p = stdWeights[i] / wsum;
    meanW += p * masters[i].w;
    meanRects += p * masters[i].rectCount;
    acc += p; stdCdf[i] = acc;
  }
  stdCdf[N_STD - 1] = 1;

  // --- die size, solved analytically from meanW and the mean density.
  // Each fill step advances by one master width whether or not it places, so
  // expected cells = (dieArea / (meanW * ROW_H)) * meanDensity.
  const density = makeDensityField(rand, opts.densityLo, opts.densityHi);
  const stdTarget = opts.count;
  const dieArea = (stdTarget * meanW * ROW_H / density.mean) / (1 - MACRO_AREA_FRAC);
  const side = Math.sqrt(dieArea);
  const dieW = Math.max(SITE_W * 256, Math.round(side / SITE_W) * SITE_W);
  const dieH = Math.max(ROW_H * 64, Math.round(side / ROW_H) * ROW_H);
  const numRows = dieH / ROW_H;

  // --- macro masters, sized relative to the die.
  const macroBase = masters.length;
  const nMacroPlaced = 3 + Math.floor(rand() * 4);              // 3..6 placed
  const perMacro = dieW * dieH * MACRO_AREA_FRAC / nMacroPlaced;
  for (let i = 0; i < N_MACRO; i++) {
    const ar = 0.6 + rand() * 1.0;                              // aspect ratio
    const mw = Math.round(Math.sqrt(perMacro * ar) / SITE_W) * SITE_W;
    const mh = Math.round(Math.sqrt(perMacro / ar) / ROW_H) * ROW_H;
    masters.push(buildMacro(rects, Math.max(SITE_W * 20, mw), Math.max(ROW_H * 8, mh)));
  }
  // --- power strap masters.
  const pwrBase = masters.length;
  masters.push(buildStrap(rects, 800, PWR_SEG));    // narrow vertical
  masters.push(buildStrap(rects, PWR_SEG, 800));    // narrow horizontal
  masters.push(buildStrap(rects, 1600, PWR_SEG));   // wide vertical
  masters.push(buildStrap(rects, PWR_SEG, 1600));   // wide horizontal

  // --- place macros, non-overlapping, snapped to the placement grid.
  const macros = [];
  for (let tries = 0; macros.length < nMacroPlaced && tries < 600; tries++) {
    const mi = macroBase + Math.floor(rand() * N_MACRO);
    const m = masters[mi];
    if (m.w > dieW * 0.75 || m.h > dieH * 0.75) continue;
    const mx = Math.round(rand() * (dieW - m.w) / SITE_W) * SITE_W;
    const my = Math.round(rand() * (dieH - m.h) / ROW_H) * ROW_H;
    const pad = ROW_H * 6;
    let hit = false;
    for (const o of macros)
      if (mx < o.x + o.w + pad && mx + m.w + pad > o.x &&
          my < o.y + o.h + pad && my + m.h + pad > o.y) { hit = true; break; }
    if (hit) continue;
    macros.push({ master: mi, x: mx, y: my, w: m.w, h: m.h });
  }

  // --- instance arrays (SoA). Sized with headroom, truncated at the end.
  const capacity = Math.ceil(stdTarget * 1.3) + 65536;
  const ix = new Int32Array(capacity);
  const iy = new Int32Array(capacity);
  const im = new Uint16Array(capacity);
  const io = new Uint8Array(capacity);
  let n = 0;
  const emit = (m, x, y, o) => { ix[n] = x; iy[n] = y; im[n] = m; io[n] = o; n++; };

  for (const m of macros) emit(m.master, m.x, m.y, O.N);
  const macroCount = n;

  // --- power grid, on its own layer, spanning the whole die.
  for (let gx = PWR_PITCH; gx < dieW - 1600; gx += PWR_PITCH) {
    const wide = ((gx / PWR_PITCH) | 0) % 4 === 0;
    const mid = pwrBase + (wide ? 2 : 0);
    for (let y = 0; y + PWR_SEG <= dieH; y += PWR_SEG) emit(mid, gx, y, O.N);
  }
  for (let gy = PWR_PITCH; gy < dieH - 1600; gy += PWR_PITCH) {
    const wide = ((gy / PWR_PITCH) | 0) % 4 === 0;
    const mid = pwrBase + (wide ? 3 : 1);
    for (let x = 0; x + PWR_SEG <= dieW; x += PWR_SEG) emit(mid, x, gy, O.N);
  }
  const pwrCount = n - macroCount;

  // --- standard cell rows.
  const invW = 1 / dieW, invH = 1 / dieH;
  const rowMacros = [];
  for (let r = 0; r < numRows && n < capacity - 8; r++) {
    const y = r * ROW_H;
    rowMacros.length = 0;
    for (const m of macros) if (y + ROW_H > m.y && y < m.y + m.h) rowMacros.push(m);
    const orient = (r & 1) ? O.FS : O.N;
    const dv = y * invH;
    let x = 0;
    while (x < dieW) {
      let blocked = null;
      for (const m of rowMacros) if (x >= m.x && x < m.x + m.w) { blocked = m; break; }
      if (blocked) { x = blocked.x + blocked.w; continue; }

      // pick a master from the skewed usage distribution
      const u = rand();
      let lo = 0, hi = N_STD - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (stdCdf[mid] < u) lo = mid + 1; else hi = mid; }
      const mw = masters[lo].w;
      if (x + mw > dieW) break;
      let clip = false;
      for (const m of rowMacros) if (x + mw > m.x && x < m.x + m.w) { clip = true; break; }
      if (!clip && rand() < density(x * invW, dv)) emit(lo, x, y, orient);
      x += mw;
      if (n >= capacity - 8) break;
    }
  }

  return {
    masters, rects,
    instances: {
      x: ix.subarray(0, n), y: iy.subarray(0, n),
      m: im.subarray(0, n), o: io.subarray(0, n), n,
    },
    dieW, dieH, numRows,
    macroCount, pwrCount,
    stdCount: n - macroCount - pwrCount,
    densityMean: density.mean,
    meanW, meanRects,
    genMs: Date.now() - t0,
  };
}

module.exports = {
  generate, mulberry32, makeDensityField,
  ROW_H, SITE_W, DBU_PER_MICRON, L, K, O,
  N_STD, N_MACRO, N_PWR, PWR_PITCH, PWR_SEG,
};
