// The design picker, and the two forms that make a design.
//
// A design is a directory of tiles, and there is more than one of them now. The
// viewer used to read whichever one happened to be called `data`, so switching
// meant renaming folders on disk - which stops working at the second design and
// makes a shared link ambiguous about what it is even showing.
//
// So: `?data=<dir>` names the design, the server lists what it has, and this is
// the surface that puts the two together. It composes with every other
// parameter for free, because the URL already is the view.
//
// SWITCHING RESETS THE CAMERA. A position that meant something on a
// 2.47 x 2.47 mm die means nothing on a 1.49 x 1.62 mm one, and carrying it
// across strands you in empty space with `placements 0` and nothing on screen
// to say why. That is the same class of silent failure as the two bugs the
// runtime gate was written for, so the camera keys are dropped on the way out
// and the display keys - layers, colour, HUD mode - are kept, because those are
// about how you like to look at things rather than about where you were.
//
// TILING STAYS OFFLINE. The two forms below upload files and POST parameters;
// the server shells out to tools/import-def.js and tools/gen.js and streams
// their stdout back. There is no parser here and no writer here. That is the
// whole architecture: the expensive work happens once, in a process, and an
// 89 GB DEF was never going to be held in a tab.

// What the server will take. Kept in step with UPLOAD_MAX in tools/serve.js,
// and both of them sit under a harder limit than either: the importer reads
// each file into one JavaScript string, and V8 caps a string at about 512 MB.
const FILE_MAX = 256 * 1024 * 1024;
const TOTAL_MAX = 600 * 1024 * 1024;
const NEEDED = ['cells.lef', 'tech.lef', 'floorplan.def'];

// URL keys that describe where the camera is rather than how the view is set
// up. Dropped when the design changes.
const CAMERA_KEYS = ['view', 'z', 'auto', 'pick', 'chip'];

const mb = b => (b / 1048576).toFixed(b < 10 * 1048576 ? 2 : 1) + ' MB';
const um = v => (v / 1000).toFixed(0);
const fmt = n => Number(n).toLocaleString('en-US');
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The URL for a design, keeping display state and dropping the camera.
export function urlForDesign(name) {
  const p = new URLSearchParams(location.search);
  for (const k of CAMERA_KEYS) p.delete(k);
  for (const k of ['pan', 'fling', 'sweep', 'check']) p.delete(k);
  p.set('data', name);
  const safe = v => (/^[\w.,:+\-/]*$/.test(v) ? v : encodeURIComponent(v));
  const q = [...p.entries()].map(([k, v]) => `${k}=${safe(v)}`).join('&');
  return location.pathname + (q ? '?' + q : '');
}

export class DesignPanel {
  // ctx: { current, onStatus(text) }
  constructor(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.files = new Map();          // basename -> File
    this.busy = false;
    this.jobs = true;
    this._build();
    el.addEventListener('click', e => this._click(e));
    el.addEventListener('change', e => this._change(e));
    // Dropping a benchmark directory onto the panel is the same as choosing it.
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dg-drag'); });
    el.addEventListener('dragleave', () => el.classList.remove('dg-drag'));
    el.addEventListener('drop', e => this._drop(e));
  }

  get on() { return this.el.classList.contains('on'); }
  set on(v) {
    this.el.classList.toggle('on', !!v);
    if (v) this.refresh();
  }
  toggle() { this.on = !this.on; }

  _build() {
    this.el.innerHTML = `
<div class="dg-h">designs<span class="dg-k">o &nbsp;/&nbsp; esc</span></div>
<div class="dg-list" id="dgList">reading the server...</div>

<div class="dg-h2">import a LEF/DEF</div>
<div class="dg-form" id="dgImport">
  <label class="dg-file">
    <input type="file" id="dgFiles" multiple webkitdirectory directory>
    <span>choose a benchmark directory</span>
  </label>
  <label class="dg-file">
    <input type="file" id="dgFiles2" multiple>
    <span>or the three files</span>
  </label>
  <div class="dg-files" id="dgPicked">cells.lef, tech.lef and floorplan.def - or drop the directory here</div>
  <div class="dg-row">
    <label>name <input type="text" id="dgOut" size="18" spellcheck="false" placeholder="data-something"></label>
    <label><input type="checkbox" id="dgOver"> overwrite</label>
  </div>
  <div class="dg-row">
    <label><input type="checkbox" id="dgPlace" checked> place into the DEF rows</label>
    <label><input type="checkbox" id="dgNoOut"> no SIZE box</label>
    <label>per-tile <input type="text" id="dgPerTile" size="6" value="4096" spellcheck="false"></label>
    <label><input type="checkbox" id="dgLazy"> lazy</label>
  </div>
  <div class="dg-note">a floorplan DEF has no coordinates in it - "place into the DEF rows"
  fills the design's own rows and the manifest records that it did</div>
  <button class="dg-go" data-go="import">import</button>
</div>

<div class="dg-h2">generate a synthetic design</div>
<div class="dg-form" id="dgGen">
  <div class="dg-row">
    <label>name <input type="text" id="dgGOut" size="18" spellcheck="false" value="data-synth2"></label>
    <label><input type="checkbox" id="dgGOver"> overwrite</label>
  </div>
  <div class="dg-row">
    <label>count <input type="text" id="dgCount" size="6" value="1m" spellcheck="false"></label>
    <label>blocks <input type="text" id="dgBlocks" size="5" value="70" spellcheck="false"></label>
    <label>orient
      <select id="dgOrient"><option>rows</option><option>none</option><option>all</option></select>
    </label>
    <label>seed <input type="text" id="dgSeed" size="5" value="42" spellcheck="false"></label>
    <label><input type="checkbox" id="dgGLazy"> lazy</label>
  </div>
  <div class="dg-note">100k to 50M placements; 5M is about 4.5 s and 117 MB</div>
  <button class="dg-go" data-go="generate">generate</button>
</div>

<div class="dg-h2">log</div>
<pre class="dg-log" id="dgLog">nothing yet</pre>`;
    this.list = this.el.querySelector('#dgList');
    this.log = this.el.querySelector('#dgLog');
    this.picked = this.el.querySelector('#dgPicked');
  }

  // ------------------------------------------------------------- the list
  async refresh() {
    try {
      const r = await fetch('/__designs');
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const doc = await r.json();
      this.jobs = doc.jobs !== false;
      this._renderList(doc.designs || []);
      this.el.classList.toggle('dg-nojobs', !this.jobs);
    } catch (e) {
      this.list.innerHTML =
        `<div class="dg-empty">could not read /__designs from this server (${esc(e.message)}).<br>` +
        `Serve the repo with <span class="dg-m">node tools/serve.js</span> - a plain static host ` +
        `has no design list, and <span class="dg-m">?data=</span> still works by hand.</div>`;
    }
  }

  _renderList(designs) {
    if (!designs.length) {
      this.list.innerHTML =
        `<div class="dg-empty">no designs on disk yet. Generate one below, or import a LEF/DEF.</div>`;
      return;
    }
    const cur = this.ctx.current;
    const rows = [`<div class="dg-r dg-hd"><span>name</span><span>source</span>` +
      `<span class="n">placements</span><span class="n">die</span><span class="n">on disk</span><span></span></div>`];
    for (const d of designs) {
      const here = d.name === cur;
      rows.push(
        `<div class="dg-r${here ? ' dg-cur' : ''}" data-open="${esc(d.name)}">` +
        `<span class="dg-n">${esc(d.name)}</span>` +
        `<span class="dg-s${d.source === 'synthetic' ? '' : ' dg-real'}">${esc(d.source)}</span>` +
        `<span class="n">${fmt(d.placements)}</span>` +
        `<span class="n">${um(d.dieW)}&times;${um(d.dieH)}&micro;m</span>` +
        `<span class="n">${mb(d.bytes)}${d.lazy ? ' <i>lazy</i>' : ''}</span>` +
        `<span class="dg-w">${d.synthesizedPlacement ? 'placement synthesized'
                              : here ? '<i>current</i>' : ''}</span>` +
        `</div>`);
    }
    rows.push(`<div class="dg-note">opening a design resets the camera to fit its die; ` +
              `layers, colour and HUD mode carry over</div>`);
    this.list.innerHTML = rows.join('');
  }

  // ------------------------------------------------------------- events
  _click(e) {
    const row = e.target.closest('[data-open]');
    if (row) { location.assign(urlForDesign(row.dataset.open)); return; }
    const go = e.target.closest('[data-go]');
    if (!go) return;
    if (this.busy) return;
    if (go.dataset.go === 'import') this._import();
    else this._generate();
  }

  _change(e) {
    if (e.target.id !== 'dgFiles' && e.target.id !== 'dgFiles2') return;
    this._take([...e.target.files]);
  }

  _drop(e) {
    e.preventDefault();
    this.el.classList.remove('dg-drag');
    const out = [];
    if (e.dataTransfer.items) {
      for (const it of e.dataTransfer.items) {
        const f = it.getAsFile && it.getAsFile();
        if (f) out.push(f);
      }
    }
    this._take(out.length ? out : [...(e.dataTransfer.files || [])]);
  }

  // Keep only the three files an import needs, whatever was handed over.
  _take(list) {
    this.files.clear();
    for (const f of list) {
      const base = (f.name || '').split(/[\\/]/).pop().toLowerCase();
      if (NEEDED.includes(base)) this.files.set(base, f);
    }
    const have = NEEDED.filter(n => this.files.has(n));
    const missing = NEEDED.filter(n => !this.files.has(n));
    if (!have.length) {
      this.picked.innerHTML = `<span class="dg-bad">none of cells.lef, tech.lef, floorplan.def in that</span>`;
      return;
    }
    let total = 0;
    const parts = have.map(n => { total += this.files.get(n).size; return `${n} ${mb(this.files.get(n).size)}`; });
    this.picked.innerHTML = parts.join(' &nbsp; ') +
      (missing.length ? ` &nbsp; <span class="dg-bad">missing ${missing.join(', ')}</span>` : '') +
      ` &nbsp; <i>${mb(total)} total</i>`;
    // Name the output after the directory the files came from, which is what
    // the benchmark is called.
    const outEl = this.el.querySelector('#dgOut');
    if (!outEl.value) {
      const rel = (list[0] && list[0].webkitRelativePath) || '';
      const dir = rel.split('/')[0];
      if (dir) outEl.value = 'data-' + dir.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
    }
  }

  // ------------------------------------------------------------- logging
  _clear() { this.log.textContent = ''; }
  _say(line) {
    this.log.textContent += line + '\n';
    this.log.scrollTop = this.log.scrollHeight;
    if (this.ctx.onStatus) this.ctx.onStatus(line.trim().slice(0, 120));
  }
  _lock(on) {
    this.busy = on;
    this.el.classList.toggle('dg-busy', on);
    for (const b of this.el.querySelectorAll('.dg-go')) b.disabled = on;
  }

  // ------------------------------------------------------------- import
  async _import() {
    const missing = NEEDED.filter(n => !this.files.has(n));
    this._clear();
    if (missing.length) {
      this._say(`missing ${missing.join(', ')}.`);
      this._say('An import needs cells.lef, tech.lef and floorplan.def. Choose the benchmark');
      this._say('directory and all three are picked up from it.');
      return;
    }
    // The ceiling, and why it is where it is. Refusing here beats a tab that
    // dies halfway through a 4 GB upload.
    let total = 0;
    for (const n of NEEDED) {
      const f = this.files.get(n);
      total += f.size;
      if (f.size > FILE_MAX) {
        this._say(`${n} is ${mb(f.size)}, over the ${mb(FILE_MAX)} limit for this route.`);
        this._say('');
        this._say('That is not a browser limitation being conservative. tools/import-def.js reads');
        this._say('each file into one JavaScript string and V8 caps a string at about 512 MB, so a');
        this._say('file this size does not go through it on the CLI either. Streaming a DEF that');
        this._say('big is what the real parser is for; this one is a throwaway aimed at questions.');
        return;
      }
    }
    if (total > TOTAL_MAX) {
      this._say(`${mb(total)} in total, over the ${mb(TOTAL_MAX)} limit for one import. Run the CLI:`);
      this._say('  node tools/import-def.js --dir <dir> --place rows --out data-<name>');
      return;
    }

    const out = this.el.querySelector('#dgOut').value.trim();
    if (!out) { this._say('give the design a name - it becomes the directory and the ?data= value'); return; }

    this._lock(true);
    const job = 'j' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      for (const n of NEEDED) {
        const f = this.files.get(n);
        this._say(`uploading ${n}  ${mb(f.size)}`);
        const r = await fetch(`/__upload?job=${job}&name=${encodeURIComponent(n)}`,
                              { method: 'POST', body: f });
        if (!r.ok) { this._say(await r.text()); this._lock(false); return; }
      }
      this._say('');
      await this._stream('/__import', {
        job, out,
        overwrite: this.el.querySelector('#dgOver').checked,
        place: this.el.querySelector('#dgPlace').checked,
        noOutline: this.el.querySelector('#dgNoOut').checked,
        perTile: +this.el.querySelector('#dgPerTile').value || 4096,
        lazy: this.el.querySelector('#dgLazy').checked,
      }, out);
    } catch (e) {
      this._say('failed: ' + e.message);
    }
    this._lock(false);
  }

  // ------------------------------------------------------------- generate
  async _generate() {
    this._clear();
    const out = this.el.querySelector('#dgGOut').value.trim();
    if (!out) { this._say('give the design a name'); return; }
    this._lock(true);
    try {
      await this._stream('/__generate', {
        out,
        overwrite: this.el.querySelector('#dgGOver').checked,
        count: this.el.querySelector('#dgCount').value.trim(),
        blocks: this.el.querySelector('#dgBlocks').value.trim(),
        seed: this.el.querySelector('#dgSeed').value.trim(),
        orient: this.el.querySelector('#dgOrient').value,
        lazy: this.el.querySelector('#dgGLazy').checked,
      }, out);
    } catch (e) {
      this._say('failed: ' + e.message);
    }
    this._lock(false);
  }

  // The tool's own stdout, line by line, exactly as the CLI prints it. The
  // layer table, the master stats, the bucket caps and the PLACEMENT
  // SYNTHESIZED banner are the most useful thing either tool produces, and
  // swallowing them to show a spinner would be throwing away the output to
  // report that there was some.
  async _stream(url, body, out) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let tail = '', ok = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      tail += dec.decode(value, { stream: true });
      const lines = tail.split('\n');
      tail = lines.pop();
      for (const l of lines) {
        if (l === '__done') { ok = true; continue; }
        if (l.startsWith('__fail')) { ok = false; continue; }
        this._say(l);
      }
    }
    if (tail.trim() && !tail.startsWith('__')) this._say(tail);
    if (!ok) { this._say(''); this._say('-- did not finish --'); return; }
    this._say('');
    this._say(`-- done. opening ${out} --`);
    await this.refresh();
    setTimeout(() => location.assign(urlForDesign(out)), 700);
  }
}
