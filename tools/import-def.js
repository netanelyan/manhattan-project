#!/usr/bin/env node
'use strict';
// Read a real LEF/DEF and build the tile pyramid from it.
//
//   node tools/import-def.js --dir <benchmark dir> --out data-real [--place rows]
//
// THROWAWAY. This is not the parser - a real one is being written elsewhere.
// This exists to answer one question that no amount of work on the generator
// can answer, because the generator was written to match the format and the
// format was written to match the generator, and that is a closed loop:
//
//   *** a real LEF is an ABSTRACT view. A MACRO has a bounding box, pin
//   *** shapes and obstructions. It does NOT have cell internals. The
//   *** generator invents ~8.8 rectangles per placement of diffusion, poly,
//   *** contacts and local metal. What does the deepest level of the pyramid
//   *** actually have to draw when the internals are not there?
//
// So it parses only what that question needs - MACRO/SIZE/CLASS/PIN/OBS out of
// cells.lef, UNITS/DIEAREA/ROWS/COMPONENTS out of the DEF - and hands the same
// design object tools/layout.js produces to the same writer in tools/gen.js.
// Nothing downstream is told which one it got. NETS, PINS, SPECIALNETS,
// BLOCKAGES, VIAS and TRACKS are skipped.
//
// ---------------------------------------------------------------------------
// WHAT THE INPUT ACTUALLY IS, which is not what it was taken to be
//
// mgc_superblue16_a/floorplan.def is the INPUT to the ISPD 2015 placement
// contest, and its components have no coordinates:
//
//     680,450  + UNPLACED        every standard cell
//         419  + FIXED           the 50 CLASS BLOCK macros, all orient N
//
// Every other design in that archive is the same. So the file carries a real
// library, a real die, real rows, a real master mix and real instance names -
// and no placement. There is nothing in it to draw at 680k scale.
//
// `--place rows` fills the DEF's own ROWS with the unplaced components, in DEF
// order, at the design's own utilisation, skipping the fixed macros. It is
// deterministic and it is not a placer: no netlist is read, so cells that talk
// to each other do not end up near each other, and the density map is flat
// where a real one has structure. Everything it uses is real except the choice
// of which row and which x, and the manifest says so in `provenance`. Without
// the flag the import stops rather than quietly inventing coordinates.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const F = require('./format.js');
const { buildDesign } = require('./gen.js');

// LEF orientation names are the DEF's, and ours: same eight, same order.
const O = { N: 0, S: 1, W: 2, E: 3, FN: 4, FS: 5, FW: 6, FE: 7 };
const K = { STD: 0, MACRO: 1, PWR: 2, FILL: 3 };

// Our twelve process layer ids against a real routing stack. tech.lef here
// declares metal1..metal9 and via1..via8 - seventeen routing layers - and the
// id space stops at metal3 because it also has to hold nwell, diff, poly,
// contact, pin, macro, power and the three instance categories inside sixteen.
// Everything above metal3 folds onto metal3 and is counted, because a silent
// fold would make the layer panel lie about what it is showing.
const L = {
  OUTLINE: 0, NWELL: 1, DIFF: 2, POLY: 3, CONT: 4, METAL1: 5,
  VIA1: 6, METAL2: 7, METAL3: 8, PIN: 9, MACRO: 10, PWR: 11,
};
const LAYER_MAP = {
  metal1: L.METAL1, metal2: L.METAL2, metal3: L.METAL3,
  via1: L.VIA1,
  // No id exists for these. Folded, and reported.
  metal4: L.METAL3, metal5: L.METAL3, metal6: L.METAL3,
  metal7: L.METAL3, metal8: L.METAL3, metal9: L.METAL3,
  via2: L.VIA1, via3: L.VIA1, via4: L.VIA1,
  via5: L.VIA1, via6: L.VIA1, via7: L.VIA1, via8: L.VIA1,
};
const FOLDED = new Set(['metal4', 'metal5', 'metal6', 'metal7', 'metal8', 'metal9',
                        'via2', 'via3', 'via4', 'via5', 'via6', 'via7', 'via8']);

const fmt = n => n.toLocaleString('en-US');
const um = nm => (nm / 1000).toFixed(1) + 'um';
const pct = f => (100 * f).toFixed(1) + '%';

// ---------------------------------------------------------------- cli
function parseArgs(argv) {
  const o = { dir: '', out: 'data-real', perTile: 4096, buckets: F.DEFAULT_BUCKETS,
              place: '', verify: true, lazy: false, report: false, outline: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(1); }
      return v;
    };
    switch (a) {
      case '--dir':       o.dir = next(); break;
      case '--out':       o.out = next(); break;
      case '--per-tile':  o.perTile = +next(); break;
      case '--buckets':   o.buckets = +next(); break;
      case '--place':     o.place = next(); break;
      case '--no-outline': o.outline = false; break;
      case '--report':    o.report = true; break;
      case '--lazy':      o.lazy = true; break;
      case '--no-verify': o.verify = false; break;
      case '-h': case '--help': usage(); process.exit(0);
      default: console.error(`unknown flag ${a}`); usage(); process.exit(1);
    }
  }
  if (!o.dir) { console.error('--dir is required (a directory holding cells.lef, tech.lef, floorplan.def)'); process.exit(1); }
  if (o.place && o.place !== 'rows') { console.error("--place accepts only 'rows'"); process.exit(1); }
  return o;
}

function usage() {
  console.log(`import a real LEF/DEF into the tile format

  --dir DIR       benchmark directory: cells.lef, tech.lef, floorplan.def
  --out DIR       output directory                              [data-real]
  --place rows    fill the DEF's own ROWS with the UNPLACED components.
                  Required for any design whose COMPONENTS are UNPLACED, and
                  the only thing here that is not read out of the files
  --no-outline    do not emit the LEF SIZE box as a rectangle. A cell is then
                  its pins and nothing else, which is what LEF literally holds
  --per-tile N    target placements per deepest tile             [4096]
  --buckets N     rect-count buckets to derive                   [8]
  --report        parse and report only; write nothing
  --lazy          far levels plus a placement index
  --no-verify     skip the verify pass that normally follows`);
}

// ---------------------------------------------------------------- tech.lef
//
// Only two things are wanted: the database units the LEF states its own
// numbers in, and the routing stack, which is the measurement that says how
// far our twelve process ids are from a real one.
function parseTechLef(text) {
  const layers = [];
  let dbu = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    // Anchored to column 0 on the raw line. A LAYER inside a VIA or inside
    // PROPERTYDEFINITIONS is a reference, not a declaration, and counting those
    // turns a 17-layer stack into 847 of them.
    let m = /^LAYER\s+(\S+)/.exec(line);
    if (m) { layers.push({ name: m[1], type: '' }); continue; }
    m = /^TYPE\s+(\S+)\s*;/.exec(t);
    if (m && layers.length) layers[layers.length - 1].type = m[1];
    m = /^DATABASE\s+MICRONS\s+([0-9.]+)\s*;/.exec(t);
    if (m) dbu = +m[1];
  }
  return { layers, dbu };
}

// ---------------------------------------------------------------- cells.lef
//
// A flat state machine over the lines. LEF is nested but the nesting that
// matters here is two deep: which MACRO, and whether the current rectangles
// belong to a PIN's PORT or to the OBS block.
function parseCellsLef(text, dbu, opts) {
  const t0 = Date.now();
  const masters = [];
  const rects = [];
  const nameOf = [];
  const stats = {
    lines: 0, pinRects: 0, obsRects: 0, outlineRects: 0, polygons: 0,
    layerHist: new Map(), foldedRects: 0, nonZeroOrigin: 0,
    clampedRects: 0, droppedRects: 0, classHist: new Map(),
    pinCount: 0, sizes: [],
  };

  let cur = null, curLayer = -1, curLayerName = '', inObs = false, inPin = false;
  const S = v => Math.round(v * dbu);

  for (const raw of text.split('\n')) {
    stats.lines++;
    const t = raw.trim();
    if (!t) continue;

    if (cur === null) {
      const m = /^MACRO\s+(\S+)/.exec(t);
      if (m) {
        cur = { name: m[1], klass: K.STD, className: '', w: 0, h: 0, ox: 0, oy: 0,
                rectStart: rects.length / 8, rectCount: 0 };
        inObs = false; inPin = false; curLayer = -1;
      }
      continue;
    }

    if (t.startsWith('END ') && t.slice(4).trim() === cur.name) {
      // The LEF SIZE box, emitted first so it sits at the bottom of the depth
      // key and the pins draw over it. This is not invented geometry: SIZE is
      // in the file, and a cell abstract IS a box with pins on it. --no-outline
      // turns it off, and then a standard cell is three or four pin rectangles
      // in empty space, which is the literal content of the LEF.
      if (opts.outline) {
        rects.splice(cur.rectStart * 8, 0, 0, 0, cur.w, cur.h, L.OUTLINE, 0, 0, 0);
        cur.rectCount++;
        stats.outlineRects++;
      }
      cur.rowH = cur.klass === K.MACRO ? 0 : cur.h;
      masters.push(cur);
      nameOf.push(cur.name);
      stats.sizes.push([cur.w, cur.h]);
      cur = null;
      continue;
    }

    let m = /^CLASS\s+(\S+)/.exec(t);
    if (m) {
      cur.className = m[1];
      stats.classHist.set(m[1], (stats.classHist.get(m[1]) || 0) + 1);
      // LEF's classes against ours. CORE is a standard cell; BLOCK is a hard
      // macro. CORE SPACER and CORE feedthru would be filler, and RING/PAD
      // power - neither appears in this library, which is itself the finding
      // under "four classes, two of them observed".
      cur.klass = m[1] === 'BLOCK' ? K.MACRO : K.STD;
      continue;
    }
    m = /^SIZE\s+([0-9.eE+-]+)\s+BY\s+([0-9.eE+-]+)/.exec(t);
    if (m) { cur.w = S(+m[1]); cur.h = S(+m[2]); continue; }
    m = /^ORIGIN\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)/.exec(t);
    if (m) {
      cur.ox = S(+m[1]); cur.oy = S(+m[2]);
      if (cur.ox !== 0 || cur.oy !== 0) stats.nonZeroOrigin++;
      continue;
    }
    if (/^OBS\b/.test(t)) { inObs = true; inPin = false; curLayer = -1; continue; }
    m = /^PIN\s+(\S+)/.exec(t);
    if (m) { inPin = true; inObs = false; stats.pinCount++; continue; }
    if (/^END\s+\S+/.test(t) && inPin) { inPin = false; continue; }
    if (/^END\s*$/.test(t)) { inObs = false; curLayer = -1; continue; }

    m = /^LAYER\s+(\S+)/.exec(t);
    if (m) {
      curLayerName = m[1];
      stats.layerHist.set(curLayerName, (stats.layerHist.get(curLayerName) || 0) + 1);
      curLayer = LAYER_MAP[curLayerName];
      if (curLayer === undefined) curLayer = L.METAL3;
      continue;
    }
    if (/^POLYGON\b/.test(t)) { stats.polygons++; continue; }

    m = /^RECT\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)/.exec(t);
    if (!m) continue;
    let x0 = S(+m[1]) - cur.ox, y0 = S(+m[2]) - cur.oy;
    let x1 = S(+m[3]) - cur.ox, y1 = S(+m[4]) - cur.oy;
    if (x1 < x0) { const s = x0; x0 = x1; x1 = s; }
    if (y1 < y0) { const s = y0; y0 = y1; y1 = s; }
    // A pin may legally hang outside SIZE; masters.bin's contract is that every
    // rectangle sits inside the master box, and verify.js asserts it. Clamp and
    // count rather than widen the box, because the box is what placement legality
    // and every content-box calculation downstream is built on.
    const cx0 = Math.max(0, Math.min(x0, cur.w)), cy0 = Math.max(0, Math.min(y0, cur.h));
    const cx1 = Math.max(0, Math.min(x1, cur.w)), cy1 = Math.max(0, Math.min(y1, cur.h));
    if (cx0 !== x0 || cy0 !== y0 || cx1 !== x1 || cy1 !== y1) stats.clampedRects++;
    if (cx1 - cx0 <= 0 || cy1 - cy0 <= 0) { stats.droppedRects++; continue; }
    if (FOLDED.has(curLayerName)) stats.foldedRects++;
    rects.push(cx0, cy0, cx1 - cx0, cy1 - cy0, curLayer, inPin ? 1 : 0, 0, 0);
    cur.rectCount++;
    if (inPin) stats.pinRects++; else if (inObs) stats.obsRects++;
  }
  stats.ms = Date.now() - t0;
  return { masters, rects, nameOf, stats };
}

// ---------------------------------------------------------------- floorplan.def
function parseDef(text, opts) {
  const t0 = Date.now();
  const out = {
    dbu: 0, die: null, rows: [], comps: [],
    status: new Map(), nameBytes: 0, nameLens: new Map(), hierNames: 0,
    orientHist: new Map(), lines: 0, ms: 0,
  };
  let section = '';
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const t = lines[li].trim();
    out.lines++;
    if (!t) continue;

    if (section === 'COMPONENTS') {
      if (t.startsWith('END COMPONENTS')) { section = ''; continue; }
      if (t[0] !== '-') continue;
      // "- name master + STATUS ( x y ) ORIENT ;" with any number of + groups.
      const tok = t.split(/\s+/);
      const name = tok[1], master = tok[2];
      let st = 'UNPLACED', x = 0, y = 0, orient = 'N';
      for (let i = 3; i < tok.length; i++) {
        const v = tok[i];
        if (v === 'UNPLACED' || v === 'PLACED' || v === 'FIXED' || v === 'COVER') {
          st = v;
          if (v !== 'UNPLACED' && tok[i + 1] === '(') {
            x = +tok[i + 2]; y = +tok[i + 3];
            orient = tok[i + 5];
          }
        }
      }
      out.status.set(st, (out.status.get(st) || 0) + 1);
      // Only where there is one to read. An UNPLACED component has no
      // orientation, and defaulting it to N and then counting it reports an
      // orientation mix the file does not contain.
      if (st !== 'UNPLACED') out.orientHist.set(orient, (out.orientHist.get(orient) || 0) + 1);
      out.nameBytes += Buffer.byteLength(name, 'utf8');
      const len = name.length;
      out.nameLens.set(len, (out.nameLens.get(len) || 0) + 1);
      if (name.includes('/')) out.hierNames++;
      out.comps.push({ name, master, st, x, y, orient });
      continue;
    }

    let m = /^UNITS\s+DISTANCE\s+MICRONS\s+([0-9.]+)/.exec(t);
    if (m) { out.dbu = +m[1]; continue; }
    m = /^DIEAREA\s*\(\s*(-?\d+)\s+(-?\d+)\s*\)\s*\(\s*(-?\d+)\s+(-?\d+)\s*\)/.exec(t);
    if (m) { out.die = { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] }; continue; }
    // ROW <name> <site> <x> <y> <orient> DO <n> BY <m> STEP <sx> <sy> ;
    m = /^ROW\s+(\S+)\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+DO\s+(\d+)\s+BY\s+(\d+)\s+STEP\s+(\d+)\s+(\d+)/.exec(t);
    if (m) {
      out.rows.push({ x: +m[3], y: +m[4], orient: m[5], sites: +m[6], by: +m[7],
                      stepX: +m[8], stepY: +m[9] });
      continue;
    }
    m = /^COMPONENTS\s+(\d+)/.exec(t);
    if (m) { section = 'COMPONENTS'; out.declared = +m[1]; continue; }
  }
  out.ms = Date.now() - t0;
  return out;
}

// ---------------------------------------------------------------- placement
//
// The part that is not read out of the files, kept in one function so it is
// obvious how small and how dumb it is.
//
// Fill the DEF's rows in DEF order, skipping spans covered by a fixed macro,
// advancing by the cell's width divided by the design's own utilisation so the
// whole core comes out at the utilisation the design actually has. Snapped to
// the row's site pitch. No netlist, no cost function, no iteration.
function placeInRows(comps, masters, byName, rows, siteW) {
  // Fixed macros first: they are real placement and they are obstructions.
  const fixed = [], loose = [];
  for (const c of comps) {
    const mi = byName.get(c.master);
    if (mi === undefined) continue;
    if (c.st === 'FIXED' || c.st === 'PLACED' || c.st === 'COVER') fixed.push({ c, mi });
    else loose.push({ c, mi });
  }

  let cellW = 0;
  for (const { mi } of loose) cellW += masters[mi].w;

  // Free width per row, after the fixed macros.
  const rowSpans = [];
  let capacity = 0;
  for (const r of rows) {
    const y0 = r.y, y1 = r.y + (masters.rowHeight || 0);
    const x0 = r.x, x1 = r.x + r.sites * r.stepX;
    let spans = [[x0, x1]];
    for (const { c, mi } of fixed) {
      const M = masters[mi];
      if (c.y + M.h <= y0 || c.y >= y1) continue;
      const next = [];
      for (const [a, b] of spans) {
        if (c.x + M.w <= a || c.x >= b) { next.push([a, b]); continue; }
        if (a < c.x) next.push([a, c.x]);
        if (c.x + M.w < b) next.push([c.x + M.w, b]);
      }
      spans = next;
    }
    rowSpans.push({ r, spans });
    for (const [a, b] of spans) capacity += b - a;
  }

  const util = cellW / capacity;
  const placed = [];
  let k = 0;
  if (util <= 1) {
    // Each free span gets a width budget of its own length times the design's
    // utilisation, and takes whole cells until the budget runs out. What the
    // budget could not spend carries to the next span, so grid snapping cannot
    // leak capacity a cell at a time and strand the tail of the list - which it
    // did, to the tune of 1,486 cells.
    //
    // Within a span the leftover width is split evenly between the cells taken,
    // so the whole core comes out at the utilisation the design actually has.
    // A real placer does the opposite - dense where the netlist is dense - and
    // that is the one thing this cannot reproduce.
    let carry = 0;
    for (const { r, spans } of rowSpans) {
      for (const [a, b] of spans) {
        const width = b - a;
        const budget = Math.min(width, width * util + carry);
        let take = 0, sum = 0;
        while (k + take < loose.length) {
          const w = masters[loose[k + take].mi].w;
          if (sum + w > budget) break;
          sum += w; take++;
        }
        carry = budget - sum + (width * util + carry - budget);
        if (!take) continue;
        const gap = (width - sum) / take;
        let fx = a;
        for (let i = 0; i < take; i++) {
          const { c, mi } = loose[k];
          const w = masters[mi].w;
          // Snapped down to the row's site pitch. Cell widths are whole sites
          // here, so x + w is on the grid too and the next snap-down cannot
          // land on top of this cell.
          let x = Math.floor((fx - r.x) / r.stepX) * r.stepX + r.x;
          if (x < a) x = Math.ceil((a - r.x) / r.stepX) * r.stepX + r.x;
          if (x + w > b) break;
          placed.push({ c, mi, x, y: r.y, orient: r.orient });
          k++;
          fx = x + w + gap;
        }
        if (k >= loose.length) break;
      }
      if (k >= loose.length) break;
    }
  }
  return { fixed, loose, placed, capacity, cellW, util, unplaced: loose.length - k };
}

// ---------------------------------------------------------------- report
function reportLef(tech, lef, opts) {
  const { masters, rects, stats } = lef;
  const nR = rects.length / 8;
  const routing = tech.layers.filter(l => l.type === 'ROUTING').length;
  const cut = tech.layers.filter(l => l.type === 'CUT').length;

  console.log(`  tech.lef    ${tech.layers.length} layers: ${routing} ROUTING, ${cut} CUT, ` +
              `dbu ${tech.dbu}/micron`);
  console.log(`              ${tech.layers.map(l => l.name).join(' ')}`);
  console.log(`  cells.lef   ${fmt(masters.length)} MACRO in ${(stats.ms / 1000).toFixed(2)}s, ` +
              `${fmt(nR)} rects  (${fmt(stats.pinRects)} pin, ${fmt(stats.obsRects)} obstruction` +
              `${opts.outline ? `, ${fmt(stats.outlineRects)} SIZE box` : ''})`);
  console.log(`              CLASS  ${[...stats.classHist].map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}`);
  console.log(`              LAYER  ${[...stats.layerHist].sort((a, b) => b[1] - a[1])
                 .map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}`);
  if (stats.polygons) console.log(`              ${fmt(stats.polygons)} POLYGON - not rectangles, skipped`);
  if (stats.nonZeroOrigin) console.log(`              ${fmt(stats.nonZeroOrigin)} masters with a non-zero ORIGIN, applied`);
  if (stats.clampedRects) console.log(`              ${fmt(stats.clampedRects)} rects clipped to the SIZE box, ${fmt(stats.droppedRects)} of them to nothing`);
  if (stats.foldedRects) {
    console.log(`              ${fmt(stats.foldedRects)} rects on a layer this format has no id for, ` +
                `folded onto metal3/via1`);
  }
}

// Rect counts per master, by class, plus the whole point of the exercise.
function reportRectsPerMaster(lef, usage, opts) {
  const { masters } = lef;
  const byClass = { 0: [], 1: [] };
  for (const m of masters) byClass[m.klass === K.MACRO ? 1 : 0].push(m.rectCount);
  const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
  for (const k of [0, 1]) byClass[k].sort((a, b) => a - b);
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  const label = { 0: 'CLASS CORE ', 1: 'CLASS BLOCK' };
  console.log(`  rects per master, over the library`);
  for (const k of [0, 1]) {
    const a = byClass[k];
    if (!a.length) continue;
    console.log(`    ${label[k]} ${fmt(a.length).padStart(6)} masters   ` +
      `min ${a[0]}  p50 ${q(a, 0.5)}  p95 ${q(a, 0.95)}  max ${a[a.length - 1]}   mean ${mean(a).toFixed(2)}`);
  }
  // Weighted by how often each master is actually placed, which is the number
  // the rectangle budget is spent against.
  let wRects = 0, wTotal = 0;
  for (let i = 0; i < masters.length; i++) {
    const u = usage[i] || 0;
    wRects += u * masters[i].rectCount;
    wTotal += u;
  }
  console.log(`    placement-weighted mean: ${(wRects / wTotal).toFixed(2)} rects per placement` +
              (opts.outline ? `  (${(wRects / wTotal - 1).toFixed(2)} without the SIZE box)` : ''));
  return wRects / wTotal;
}

function reportNames(def) {
  const lens = [...def.nameLens].sort((a, b) => a[0] - b[0]);
  const total = [...def.nameLens.values()].reduce((a, b) => a + b, 0);
  let acc = 0, p50 = 0, p95 = 0, max = 0, min = 1e9;
  for (const [len, cnt] of lens) {
    min = Math.min(min, len); max = Math.max(max, len);
    acc += cnt;
    if (!p50 && acc >= total * 0.5) p50 = len;
    if (!p95 && acc >= total * 0.95) p95 = len;
  }
  const mean = def.nameBytes / total;
  console.log(`  instance names  ${fmt(total)} names, ${fmt(def.nameBytes)} bytes of UTF-8 ` +
              `(${(def.nameBytes / 1048576).toFixed(2)} MB)`);
  console.log(`                  length min ${min}  p50 ${p50}  p95 ${p95}  max ${max}  mean ${mean.toFixed(2)}`);
  console.log(`                  ${fmt(def.hierNames)} hierarchical (contain '/'), ` +
              `${pct(def.hierNames / total)} of them`);
  const offsets = total * 4;
  console.log(`                  as a side table: ${fmt(def.nameBytes)} bytes of text + ` +
              `${fmt(offsets)} bytes of u32 offset = ${((def.nameBytes + offsets) / 1048576).toFixed(2)} MB`);
  console.log(`                  in the placement record: 12 bytes -> 16, ` +
              `+${fmt(total * 4)} bytes per deep or mid level`);
  return { total, mean, min, p50, p95, max, bytes: def.nameBytes };
}

// ---------------------------------------------------------------- main
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.resolve(opts.dir);
  const P = f => path.join(dir, f);
  for (const f of ['cells.lef', 'tech.lef', 'floorplan.def']) {
    if (!fs.existsSync(P(f))) { console.error(`${dir} has no ${f}`); process.exit(1); }
  }

  const tRead = Date.now();
  const techText = fs.readFileSync(P('tech.lef'), 'latin1');
  const cellsText = fs.readFileSync(P('cells.lef'), 'latin1');
  const defText = fs.readFileSync(P('floorplan.def'), 'latin1');
  const readMs = Date.now() - tRead;
  const readBytes = fs.statSync(P('tech.lef')).size + fs.statSync(P('cells.lef')).size +
                    fs.statSync(P('floorplan.def')).size;
  console.log(`import      ${dir}`);
  console.log(`  read        ${(readBytes / 1048576).toFixed(1)} MB in ${readMs}ms`);

  const tech = parseTechLef(techText);
  const lefDbu = tech.dbu || 1000;
  const lef = parseCellsLef(cellsText, lefDbu, opts);
  reportLef(tech, lef, opts);

  const def = parseDef(defText, opts);
  if (!def.die) { console.error('  the DEF has no DIEAREA'); process.exit(1); }
  if (def.dbu !== lefDbu) {
    console.log(`  UNITS       DEF ${def.dbu}/micron vs LEF ${lefDbu}/micron - LEF numbers scaled by ${def.dbu / lefDbu}`);
  }
  const dieW = def.die.x1 - def.die.x0, dieH = def.die.y1 - def.die.y0;
  console.log(`  floorplan.def  ${fmt(def.declared)} COMPONENTS in ${(def.ms / 1000).toFixed(2)}s, ` +
              `die ${um(dieW)} x ${um(dieH)}, ${fmt(def.rows.length)} ROWS`);
  console.log(`              status  ${[...def.status].map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}`);
  console.log(`              orient  ${[...def.orientHist].map(([k, v]) => `${k} ${fmt(v)}`).join(', ') || 'none stated'}` +
              `   (over the ${fmt([...def.orientHist.values()].reduce((a, b) => a + b, 0))} that carry a placement at all)`);

  const byName = new Map(lef.nameOf.map((n, i) => [n, i]));
  const usage = new Int32Array(lef.masters.length);
  let missing = 0;
  for (const c of def.comps) {
    const mi = byName.get(c.master);
    if (mi === undefined) { missing++; continue; }
    usage[mi]++;
  }
  if (missing) console.log(`  ${fmt(missing)} components name a master that is not in cells.lef`);

  const meanRects = reportRectsPerMaster(lef, usage, opts);
  const names = reportNames(def);

  // Row geometry, which is where the placement goes.
  const rowH = def.rows.length ? def.rows[0].stepY || lef.masters.find(m => m.klass === K.STD).h : 0;
  const siteW = def.rows.length ? def.rows[0].stepX : 100;
  const rowPitch = def.rows.length > 1 ? def.rows[1].y - def.rows[0].y : rowH;
  console.log(`  rows        ${fmt(def.rows.length)} rows, pitch ${rowPitch}nm, site ${siteW}nm, ` +
              `${fmt(def.rows[0].sites)} sites each, orient ${[...new Set(def.rows.map(r => r.orient))].join('/')}`);

  const unplaced = def.status.get('UNPLACED') || 0;
  if (unplaced && !opts.place) {
    console.error('');
    console.error(`  ${fmt(unplaced)} of ${fmt(def.comps.length)} COMPONENTS are UNPLACED - this DEF is a`);
    console.error('  floorplan, not a placed design, so there are no coordinates to tile.');
    console.error('  Re-run with --place rows to fill the DEF\'s own rows instead, which is');
    console.error('  synthesized placement over real everything-else and is recorded as such');
    console.error('  in the manifest. Or use --report to stop here with the numbers above.');
    process.exit(opts.report ? 0 : 2);
  }
  if (opts.report) return;

  // --- placement
  const tp = Date.now();
  const masters = lef.masters;
  masters.rowHeight = rowPitch;
  const pl = placeInRows(def.comps, masters, byName, def.rows, siteW);
  if (pl.util > 1) {
    console.error(`  the cells do not fit: ${um(pl.cellW)} of cell width against ${um(pl.capacity)} ` +
                  `of free row, utilisation ${pct(pl.util)}`);
    process.exit(1);
  }
  if (pl.unplaced) {
    console.error(`  ${fmt(pl.unplaced)} components did not fit into the rows`);
    process.exit(1);
  }
  console.log(`  PLACEMENT SYNTHESIZED  ${fmt(pl.placed.length)} UNPLACED components filled into the ` +
              `DEF's own rows at ${pct(pl.util)} utilisation, ${Date.now() - tp}ms`);
  console.log(`              real: library, die, rows, master mix, instance names, the ${fmt(pl.fixed.length)} fixed macros`);
  console.log(`              ours: which row and which x. No netlist is read, so the density map is ` +
              `flat where a real one has structure`);

  // --- the design object tools/gen.js writes from
  const n = pl.placed.length + pl.fixed.length;
  const ix = new Int32Array(n), iy = new Int32Array(n);
  const im = new Uint16Array(n), io = new Uint8Array(n);
  let w = 0;
  for (const { c, mi } of pl.fixed) {
    ix[w] = c.x - def.die.x0; iy[w] = c.y - def.die.y0;
    im[w] = mi; io[w] = O[c.orient] ?? 0; w++;
  }
  for (const p of pl.placed) {
    ix[w] = p.x - def.die.x0; iy[w] = p.y - def.die.y0;
    im[w] = p.mi; io[w] = O[p.orient] ?? 0; w++;
  }

  // The rect-count histogram the bucket caps are solved from, weighted by how
  // often each master is really placed. This is the input that was previously
  // a property of the generator and is now a property of a real library.
  const rectHist = new Map();
  let meanW = 0, total = 0;
  for (let i = 0; i < masters.length; i++) {
    const u = usage[i];
    if (!u) continue;
    total += u;
    meanW += u * masters[i].w;
    const rc = masters[i].rectCount;
    rectHist.set(rc, (rectHist.get(rc) || 0) + u);
  }
  meanW /= total;
  for (const [k, v] of rectHist) rectHist.set(k, v / total);

  const maxZ = Math.max(0, Math.ceil(Math.log2(Math.sqrt(n / opts.perTile))));
  const tilesPerSide = 1 << maxZ;
  const tileSize = Math.ceil(Math.max(dieW, dieH) / tilesPerSide / siteW) * siteW;
  const worldSize = tileSize * tilesPerSide;

  const gen = {
    masters, rects: lef.rects,
    instances: { x: ix, y: iy, m: im, o: io, n },
    dieW, dieH, numRows: def.rows.length,
    dbuPerMicron: def.dbu, rowH: rowPitch, siteW,
    source: 'lef/def',
    provenance: {
      dir: path.basename(dir),
      placement: pl.placed.length ? 'synthesized: DEF rows filled in DEF order' : 'from the DEF',
      unplacedInInput: unplaced,
      fixedInInput: pl.fixed.length,
      utilisation: +pl.util.toFixed(4),
      routingLayersInTech: tech.layers.filter(l => l.type === 'ROUTING').length,
      layerFoldedRects: lef.stats.foldedRects,
      sizeBoxRect: opts.outline,
      instanceNameBytes: names.bytes,
    },
    maxZ, tilesPerSide, tileSize, worldSize,
    macroCount: pl.fixed.length, pwrCount: 0,
    stdCount: pl.placed.length, fillCount: 0,
    densityMean: pl.util,
    meanW, meanRects, rectHist,
    strapAligned: false, strapSeg: 0,
    genMs: 0,
  };

  const genOpts = {
    out: opts.out, seed: 0, perTile: opts.perTile, buckets: opts.buckets,
    oneTile: false, lazy: opts.lazy, verify: opts.verify,
    blocks: 1, blockOrient: 'none', blockGap: 0,
  };
  console.log('');
  await buildDesign(gen, genOpts,
    `  instances   ${fmt(n)} = ${fmt(pl.placed.length)} standard cells + ${fmt(pl.fixed.length)} macros` +
    `   (no filler class and no power class in this LEF)`);
}

main().catch(e => { console.error(e); process.exit(1); });
