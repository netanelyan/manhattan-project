// The layer panel.
//
// Keys were the whole layer interface, and a key you have to remember is a key
// nobody presses. This is the surface people scan, and it is modelled on the
// panel the target users already have in front of them in RedHawk-SC: grouped
// rows with a parent toggle per group, and visibility and selectability as two
// separate columns rather than one.
//
// Three things come from that model.
//
// GROUPS WITH PARENT TOGGLES. "all metals" switches the whole group. With three
// metals that is a convenience; with the ten a real stack has it is the only
// way the list is usable at all.
//
// SELECTABLE IS ITS OWN AXIS. Showing a thing and letting a click land on it
// are different questions, and the case that needs them apart is exactly the
// one this viewer has: a macro sits over the cells you are trying to identify.
// pick() has always broken that tie by taking the smallest hit; the S column is
// the same decision made deliberately instead of guessed.
//
// ONE LIST FOR BOTH AXES. A row is a layer id, and the layer id space already
// holds both kinds of thing: process layers 0-11, which is what a deep tile
// carries, and the three instance categories 12-14 - cells, macros, power grid
// - which is what a mid or far tile carries. So "what kind of thing" and "which
// mask is it printed on" are rows in one list, rather than a layer toggle in
// one place and a colour mode in another. A row with no referent at the level
// on screen is dimmed rather than hidden: the state is still yours to set, and
// the dimming is the per-row version of the notice that used to say only that
// some filter somewhere was being ignored.
//
// Everything here is uniforms. Nothing in this file rebuilds a buffer,
// re-uploads a slot, or re-fetches a tile.

import { TILE_KIND, PROCESS_MASK, CATEGORY_MASK } from './format.js';
import { LAYER_COLORS, ALPHA_PRESET } from './renderer.js';

// Layers 0-11 are process layers and live only in deep tiles; 12-14 are the
// instance categories and live only in mid and far tiles. Every rule below is
// one of those two halves; the renderer draws the same line through
// effectiveMask, from the same two constants.

// The panel, top to bottom. Instances first, because at the zoom the viewer
// opens at - the whole chip - they are the only rows that apply.
//
// Digit keys read straight down the list, 1-9 and then 0, so the panel is what
// documents them. Six rows have no key: there are ten digits and more layers
// than that, which is an argument for the panel rather than against the keys.
export const GROUPS = [
  { name: 'all instances', rows: [
    { l: 12, label: 'cells',       key: '1' },
    { l: 13, label: 'macros',      key: '2' },
    { l: 14, label: 'power grid',  key: '3' },
  ] },
  { name: 'all metals', rows: [
    { l: 5,  label: 'metal1',      key: '4' },
    { l: 7,  label: 'metal2',      key: '5' },
    { l: 8,  label: 'metal3',      key: '6' },
  ] },
  // Contact is in with the vias rather than with the device layers it touches,
  // because that is where the reference panel puts it: their list runs M0/VIA0
  // upwards, and VIA0 is the one below metal1.
  { name: 'all vias', rows: [
    { l: 4,  label: 'contact',     key: '7' },
    { l: 6,  label: 'via1',        key: '8' },
  ] },
  { name: 'all device', rows: [
    { l: 1,  label: 'nwell',       key: ''  },
    { l: 2,  label: 'diff',        key: '9' },
    { l: 3,  label: 'poly',        key: '0' },
  ] },
  { name: 'all structure', rows: [
    { l: 0,  label: 'outline',     key: ''  },
    { l: 9,  label: 'pin',         key: ''  },
    { l: 10, label: 'macro body',  key: ''  },
    { l: 11, label: 'power strap', key: ''  },
  ] },
];

export const ROWS = GROUPS.flatMap(g => g.rows);

// Digit to row, in panel order: 1-9 then 0. A key drives a row, not a bit, so
// the panel and the keyboard cannot come to describe different things.
export const KEY_ROWS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
  .map(k => ROWS.find(r => r.key === k) || null);

export const isCategory = l => l >= 12;

// Whether a row has a referent in what is on screen. A deep tile draws process
// layers and nothing else; a mid or far tile draws instance categories and
// nothing else.
export const appliesAt = (l, kind) =>
  kind === TILE_KIND.DEEP ? !isCategory(l) : isCategory(l);

// Solo stays inside the row's own axis: "solo metal2" is a statement about
// process layers, and turning the instance categories off with it would blank
// every level that has no metal2 to show in the first place. The other half of
// the mask is left fully on, which is what the level itself does with it.
export const soloMask = l => (1 << l) | (isCategory(l) ? PROCESS_MASK : CATEGORY_MASK);

// The columns. V and S are the two the reference panel has that we did not; C
// is the layer's colour, and clicking it is the per-layer half of an alpha
// control that until now could only be set for every layer at once. Their panel
// has a fourth column, M, whose meaning is not known here - when it is, it is
// one more entry in this list and one more branch in _get/_set.
const COLUMNS = [
  { a: 'v', title: 'visible' },
  { a: 's', title: 'selectable - whether a click can land on it' },
  { a: 'c', title: 'colour - click to make this one layer see-through' },
];

export class LayerPanel {
  // ctx: { renderer, getSelect(), setSelect(mask), onChange(axis) }
  constructor(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.sig = '';
    this._build();
    el.addEventListener('click', e => this._click(e));
  }

  get on() { return this.el.classList.contains('on'); }
  set on(v) { this.el.classList.toggle('on', !!v); if (v) this.update(true); }
  toggle() { this.on = !this.on; }

  _build() {
    const cells = () => COLUMNS.map(c =>
      `<span class="lp-c" data-a="${c.a}" title="${c.title}"><i class="bx"></i></span>`).join('');
    const out = [
      `<div class="lp-r lp-h"><span class="lp-l">layer</span>` +
      COLUMNS.map(c => `<span class="lp-c" title="${c.title}">${c.a.toUpperCase()}</span>`).join('') +
      `<span class="lp-k">key</span></div>`,
    ];
    GROUPS.forEach((g, gi) => {
      out.push(`<div class="lp-r lp-g" data-g="${gi}"><span class="lp-l">${g.name}</span>` +
               cells() + `<span class="lp-k"></span></div>`);
      for (const r of g.rows) {
        out.push(`<div class="lp-r" data-l="${r.l}"><span class="lp-l">${r.label}</span>` +
                 cells() + `<span class="lp-k">${r.key}</span></div>`);
      }
    });
    out.push(`<div class="lp-f">S is inert where a click cannot resolve to it, ` +
             `and a dimmed row has no referent at the level on screen.</div>`);
    this.el.innerHTML = out.join('');

    this.rowEls = new Map();
    for (const el of this.el.querySelectorAll('[data-l]')) this.rowEls.set(+el.dataset.l, el);
    this.groupEls = [...this.el.querySelectorAll('[data-g]')];
    // The colour chip is fixed for the run - the palette is a constant and a
    // row is one layer id - so it is written once rather than on every update.
    for (const [l, el] of this.rowEls) {
      const chip = el.querySelector('[data-a="c"] .bx');
      chip.classList.add('sw');
      chip.style.background = LAYER_COLORS[l];
    }
  }

  // ------------------------------------------------------------------ state
  _click(e) {
    const cell = e.target.closest('[data-a]');
    if (!cell || !this.el.contains(cell)) return;
    const row = cell.parentElement;
    const axis = cell.dataset.a;
    if (row.classList.contains('lp-inert-s') && axis === 's') return;
    const layers = row.dataset.l !== undefined
      ? [+row.dataset.l]
      : GROUPS[+row.dataset.g].rows.map(r => r.l);
    // A parent toggle is "make them agree": anything on turns the group off,
    // nothing on turns it on. That is what makes one click useful in both
    // directions, which is the whole reason the parent row exists.
    const on = !layers.some(l => this._get(axis, l));
    for (const l of layers) this._set(axis, l, on);
    this.ctx.onChange(axis);
    this.update(true);
  }

  _get(axis, l) {
    const R = this.ctx.renderer;
    if (axis === 'v') return ((R.layerMask >> l) & 1) === 1;
    if (axis === 's') return ((this.ctx.getSelect() >> l) & 1) === 1;
    return R.layerAlpha[l] < 1;                     // c: see-through
  }

  _set(axis, l, on) {
    const R = this.ctx.renderer;
    if (axis === 'v') {
      R.layerMask = on ? (R.layerMask | (1 << l)) : (R.layerMask & ~(1 << l));
      return;
    }
    if (axis === 's') {
      const m = this.ctx.getSelect();
      this.ctx.setSelect(on ? (m | (1 << l)) : (m & ~(1 << l)));
      return;
    }
    // A layer whose preset is opaque has nothing to see through, so asking for
    // alpha on it does nothing rather than making it disappear.
    R.layerAlpha[l] = on ? ALPHA_PRESET[l] : 1;
  }

  // Reflect state. Called every frame, so it does nothing at all unless
  // something it draws has actually changed.
  update(force) {
    if (!this.on) return;
    const R = this.ctx.renderer;
    const sig = `${R.layerMask}/${this.ctx.getSelect()}/${R.kind}/` +
                ROWS.map(r => R.layerAlpha[r.l]).join(',');
    if (!force && sig === this.sig) return;
    this.sig = sig;

    for (const [l, el] of this.rowEls) {
      el.classList.toggle('lp-off', !appliesAt(l, R.kind));
      // S has a referent only where a click can resolve to it, and what a click
      // resolves to is a placement or a density block - a category, never a
      // mask. So the column is inert on a process row rather than a control
      // that silently does nothing.
      el.classList.toggle('lp-inert-s', !isCategory(l));
      for (const c of COLUMNS) {
        el.querySelector(`[data-a="${c.a}"] .bx`).classList.toggle('on', this._get(c.a, l));
      }
    }
    this.groupEls.forEach((el, gi) => {
      const rows = GROUPS[gi].rows;
      el.classList.toggle('lp-off', !rows.some(r => appliesAt(r.l, R.kind)));
      el.classList.toggle('lp-inert-s', !rows.some(r => isCategory(r.l)));
      for (const c of COLUMNS) {
        el.querySelector(`[data-a="${c.a}"] .bx`)
          .classList.toggle('on', rows.some(r => this._get(c.a, r.l)));
      }
    });
  }
}
