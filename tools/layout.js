'use strict';
// Synthetic chip layout generator: master library + structured placement.
// Pure data production, no I/O. Integer nanometre coordinates throughout.

// ---------------------------------------------------------------- constants
const ROW_H  = 1000;   // nm, standard cell row height (site height)
const SITE_W = 200;    // nm, placement grid pitch
const DBU_PER_MICRON = 1000;

// Library size matching superblue16's cells.lef. Every measurement taken
// against a few hundred masters is optimistic: draw-call strategies that look
// fine at 400 masters fall over here.
const N_STD   = 4606;  // logic cell masters
const N_FILL  = 8;     // filler and decap masters
const N_MACRO = 12;    // memory macro masters
const N_PWR   = 8;     // power strap segment masters
                       // 4634 masters total

// Share of placements that are fillers and decoupling caps rather than logic.
// A real design is largely made of these: simple boxes, a handful of masters,
// instanced enormously. They dominate the low end of the rect-count histogram.
const FILL_SHARE = 0.30;

// Placement frequency across the logic library follows a Zipf tail: a few
// masters take most of the placements and thousands take the rest. Sampling
// uniformly across 4,634 masters is nothing like a real design.
const ZIPF_S = 1.05;
const ZIPF_Q = 2.7;

const PWR_PITCH = 50000;        // nm between power straps, both directions
const PWR_SEG_FIXED = 25000;    // nm, unaligned strap segment length
const PWR_PHASE = 7000;         // nm, offset so straps do not sit on tile edges
const MACRO_AREA_FRAC = 0.12;   // fraction of die area consumed by macros

// Layer ids. The viewer's palette and the depth-sort key both index this.
const L = {
  OUTLINE: 0, NWELL: 1, DIFF: 2, POLY: 3, CONT: 4, METAL1: 5,
  VIA1: 6, METAL2: 7, METAL3: 8, PIN: 9, MACRO: 10, PWR: 11,
};

// Cell master classes. Filler and decap are their own class rather than
// standard cells with a flag: they are the difference between area that is
// occupied and area that is doing something, which is the first question a
// full-die view has to answer.
const K = { STD: 0, MACRO: 1, PWR: 2, FILL: 3 };

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

// Filler and decap cells: implant/nwell plus power rails, and for a decap a
// gate over diffusion. Three to five rectangles, nothing else - which is
// exactly why they matter for bucket sizing.
function buildFiller(rects, w, decap) {
  const start = rects.length / 8;
  const h = ROW_H;
  const railH = 120;
  pushRect(rects, 0, 0, w, railH, L.METAL1, 0);
  pushRect(rects, 0, h - railH, w, railH, L.METAL1, 0);
  pushRect(rects, 0, railH, w, h - 2 * railH, L.NWELL, 0);
  if (decap) {
    pushRect(rects, 60, 200, w - 120, 600, L.DIFF, 0);
    pushRect(rects, Math.floor(w / 2) - 50, 150, 100, 700, L.POLY, 0);
  }
  return {
    rectStart: start, rectCount: rects.length / 8 - start,
    w, h, klass: K.FILL, rowH: ROW_H,
  };
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

  // --- logic cell library. Widths 400..4000nm on the 200nm site grid.
  const sitesOf = new Int32Array(N_STD);
  for (let i = 0; i < N_STD; i++) {
    const sites = 2 + Math.floor(Math.pow(rand(), 1.9) * 19);   // 2..20 sites
    sitesOf[i] = sites;
    masters.push(buildStdCell(rects, sites * SITE_W));
  }

  // --- filler and decap library: a handful of very simple, very common cells.
  const fillBase = masters.length;
  for (let i = 0; i < N_FILL; i++) {
    const decap = i >= N_FILL / 2;
    const sites = decap ? [4, 8, 16, 32][i - (N_FILL >> 1)] : [1, 2, 4, 8][i];
    masters.push(buildFiller(rects, sites * SITE_W, decap));
  }

  // --- placement frequency. Logic follows a Zipf tail ranked by size, so small
  // inverters and buffers dominate; fillers and decaps take FILL_SHARE of
  // everything between them.
  const rank = Array.from({ length: N_STD }, (_, i) => i);
  rank.sort((a, b) => (sitesOf[a] + rand() * 6) - (sitesOf[b] + rand() * 6));
  const weights = new Float64Array(masters.length);
  let logicSum = 0;
  for (let r = 0; r < N_STD; r++) {
    const w = 1 / Math.pow(r + 1 + ZIPF_Q, ZIPF_S);
    weights[rank[r]] = w;
    logicSum += w;
  }
  for (let i = 0; i < N_STD; i++) weights[i] *= (1 - FILL_SHARE) / logicSum;
  const fillW = [0.30, 0.24, 0.16, 0.10, 0.08, 0.06, 0.04, 0.02];
  for (let i = 0; i < N_FILL; i++) weights[fillBase + i] = FILL_SHARE * fillW[i];

  // --- flat CDF over everything placeable, plus the rect-count histogram the
  // bucket caps are derived from.
  const nPlaceable = N_STD + N_FILL;
  const cdf = new Float64Array(nPlaceable);
  const rectHist = new Map();
  let acc = 0, meanW = 0, meanRects = 0;
  for (let i = 0; i < nPlaceable; i++) {
    const p = weights[i];
    meanW += p * masters[i].w;
    meanRects += p * masters[i].rectCount;
    const rc = masters[i].rectCount;
    rectHist.set(rc, (rectHist.get(rc) || 0) + p);
    acc += p; cdf[i] = acc;
  }
  cdf[nPlaceable - 1] = 1;

  // --- die size, solved analytically from meanW and the mean density.
  // Each fill step advances by one master width whether or not it places, so
  // expected cells = (dieArea / (meanW * ROW_H)) * meanDensity.
  //
  // NOTE: this models leftover space as empty. A real design fills it with
  // filler and decap, which is why the far tile carries a filler channel the
  // synthetic data barely exercises - see docs/tile-format.md, "Dead area".
  const density = makeDensityField(rand, opts.densityLo, opts.densityHi);
  const stdTarget = opts.count;
  const dieArea = (stdTarget * meanW * ROW_H / density.mean) / (1 - MACRO_AREA_FRAC);
  const side = Math.sqrt(dieArea);
  const dieW = Math.max(SITE_W * 256, Math.round(side / SITE_W) * SITE_W);
  const dieH = Math.max(ROW_H * 64, Math.round(side / ROW_H) * ROW_H);
  const numRows = dieH / ROW_H;

  // --- pyramid geometry, decided here because the power grid depends on it.
  // maxZ comes from the requested count, not the achieved one, so it is
  // deterministic and the strap masters below can be sized against it.
  const maxZ = Math.max(0, Math.ceil(Math.log2(Math.sqrt(stdTarget / opts.perTile))));
  const tilesPerSide = 1 << maxZ;
  const tileSize = Math.ceil(Math.max(dieW, dieH) / tilesPerSide / SITE_W) * SITE_W;
  const worldSize = tileSize * tilesPerSide;

  // Power strap segmentation. Real grids do not respect tile boundaries, so
  // unaligned is the default: fixed-length segments on a phase offset, which
  // straddle tile edges and land in the overflow list. `--strap-align` sizes
  // segments to one deepest tile and snaps them, removing the bleed entirely -
  // a legitimate tiler optimisation, but it must not be the only mode, or the
  // overflow path goes untested against what a real parser will produce.
  const aligned = opts.strapAlign === true;
  const PWR_SEG = aligned ? tileSize : PWR_SEG_FIXED;
  const PWR_OFF = aligned ? 0 : PWR_PHASE;

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
  // four strap widths, vertical and horizontal, all one tile long
  for (const t of [800, 1600, 2400, 3200]) {
    masters.push(buildStrap(rects, t, PWR_SEG));    // vertical
    masters.push(buildStrap(rects, PWR_SEG, t));    // horizontal
  }

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
  let fillPlaced = 0;
  const emit = (m, x, y, o) => {
    ix[n] = x; iy[n] = y; im[n] = m; io[n] = o; n++;
    if (masters[m].klass === K.FILL) fillPlaced++;
  };

  for (const m of macros) emit(m.master, m.x, m.y, O.N);
  const macroCount = n;

  // --- power grid, on its own layer, spanning the whole die.
  // Every fourth strap is a wide trunk, the rest are narrower distribution
  // straps - the coarse grid a real floorplan gets.
  const strapWidth = k => (k % 4 === 0 ? 3 : k % 2 === 0 ? 1 : 0);
  for (let gx = PWR_PITCH, k = 1; gx < dieW - 3200; gx += PWR_PITCH, k++) {
    const mid = pwrBase + strapWidth(k) * 2;
    for (let y = PWR_OFF; y + PWR_SEG <= dieH; y += PWR_SEG) emit(mid, gx, y, O.N);
  }
  for (let gy = PWR_PITCH, k = 1; gy < dieH - 3200; gy += PWR_PITCH, k++) {
    const mid = pwrBase + strapWidth(k) * 2 + 1;
    for (let x = PWR_OFF; x + PWR_SEG <= dieW; x += PWR_SEG) emit(mid, x, gy, O.N);
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

      // pick a master from the Zipf-plus-filler usage distribution
      const u = rand();
      let lo = 0, hi = cdf.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
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
    // The units this design is stated in. Constants here, read out of the files
    // by a real importer; either way tools/gen.js takes them off the design
    // rather than off this module.
    dbuPerMicron: DBU_PER_MICRON, rowH: ROW_H, siteW: SITE_W,
    source: 'synthetic',
    maxZ, tilesPerSide, tileSize, worldSize,
    macroCount, pwrCount,
    stdCount: n - macroCount - pwrCount,
    fillCount: fillPlaced,
    densityMean: density.mean,
    meanW, meanRects, rectHist,
    strapAligned: aligned, strapSeg: PWR_SEG,
    genMs: Date.now() - t0,
  };
}

module.exports = {
  generate, mulberry32, makeDensityField,
  ROW_H, SITE_W, DBU_PER_MICRON, L, K, O,
  N_STD, N_FILL, N_MACRO, N_PWR, PWR_PITCH, FILL_SHARE,
};
