#!/usr/bin/env node
'use strict';
// The runtime gate: drive the real viewer in a real browser and fail the build
// when it draws nothing where geometry exists.
//
//   node tools/check.js [data-dir] [--port N] [--browser PATH] [--width W] [--height H]
//
// tools/verify.js reads the binaries back and checks every invariant the format
// has. It cannot catch a viewer that has the right bytes and still shows a black
// screen, because residency, culling and the per-instance origin table are
// runtime state - they exist only once a camera is somewhere. Two bugs lived in
// exactly that gap: block instances silently dropped from the visible set, and
// a level whose tiles are empty where a macro was promoted to the overflow list.
//
// So this starts the static server, opens src/?check in headless Chrome, and
// reads back the result the sweep leaves on the page. What the sweep actually
// samples is in src/main.js under "blank check"; this file is the plumbing.
//
// Core Node only - no puppeteer, no ws package. Node's own WebSocket client
// speaks enough CDP to navigate a page and evaluate one expression.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TIMEOUT_MS = 15 * 60 * 1000;

// Where a headless Chrome or Edge usually is, per platform. CHROME in the
// environment wins, because a CI image can put it anywhere.
function browsers() {
  const env = process.env.CHROME || process.env.CHROME_PATH;
  const list = env ? [env] : [];
  if (process.platform === 'win32') {
    for (const base of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'],
                        process.env.LOCALAPPDATA]) {
      if (!base) continue;
      list.push(path.join(base, 'Google/Chrome/Application/chrome.exe'));
      list.push(path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
              '/snap/bin/chromium');
  }
  return list;
}

function findBrowser(explicit) {
  for (const c of explicit ? [explicit] : browsers()) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return null;
}

// One CDP session: enough of the protocol to navigate and evaluate.
class Session {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.logs = []; }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('devtools socket refused'));
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.logs.push('page exception: ' + ((d.exception && d.exception.description) || d.text));
      }
    };
    await this.send('Runtime.enable');
    return this;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) return null;
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const argv = process.argv.slice(2);
  // 800x600 on purpose. The check renders for real, and a headless box has no
  // GPU: SwiftShader takes ~350ms a frame at 1400x900 and ~150ms at 800x600,
  // over hundreds of samples. Nothing being checked is resolution-dependent -
  // residency, culling and the origin table behave the same at any canvas size,
  // and the ladder re-solves against whatever the canvas is.
  const opt = { port: 8123, width: 800, height: 600, data: 'data', browser: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(port|width|height|browser|data)$/.exec(argv[i]);
    if (m) opt[m[1]] = m[1] === 'browser' || m[1] === 'data' ? argv[++i] : +argv[++i];
    else rest.push(argv[i]);
  }
  if (rest.length) opt.data = rest[0];

  if (!fs.existsSync(path.join(ROOT, opt.data, 'manifest.json'))) {
    console.error(`${opt.data}/ has no manifest.json - run the generator first (make gen)`);
    process.exit(1);
  }

  const exe = findBrowser(opt.browser);
  if (!exe) {
    console.error('no Chrome or Edge found. Set CHROME to the executable, or pass --browser PATH.');
    console.error('tried:\n  ' + browsers().join('\n  '));
    process.exit(1);
  }

  const server = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(opt.port)],
                       { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  // The page posts its progress to the server's /__log sink; echo it straight
  // through, so a run that takes minutes says what it is doing rather than
  // looking hung.
  server.stdout.on('data', d => {
    for (const line of String(d).split('\n')) {
      const t = line.trim();
      if (t.startsWith('blank check') || /^z\d/.test(t) || t.startsWith('FAIL')) console.log('  ' + t);
    }
  });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'manhattan-check-'));
  const port = opt.port + 1;
  // SwiftShader, because a headless CI box has no GPU and this has to render
  // for real - the whole question is what reaches the framebuffer.
  const chrome = spawn(exe, [
    '--headless=new', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', `--window-size=${opt.width},${opt.height}`,
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const done = code => {
    try { chrome.kill(); } catch { /* already gone */ }
    try { server.kill(); } catch { /* already gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* leave it */ }
    process.exit(code);
  };

  let wsUrl = null;
  for (let i = 0; i < 150 && !wsUrl; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
  }
  if (!wsUrl) { console.error('browser did not open a debugging port'); done(1); return; }

  const s = await new Session(wsUrl).open();
  const url = `http://127.0.0.1:${opt.port}/src/?check&data=/${opt.data}`;
  console.log(`blank check  ${exe}\n             ${url}  ${opt.width}x${opt.height}`);
  await s.send('Page.navigate', { url });

  const deadline = Date.now() + TIMEOUT_MS;
  let result = null;
  while (!result && Date.now() < deadline) {
    await sleep(1000);
    const raw = await s.eval('window.manhattanCheck ? JSON.stringify(window.manhattanCheck) : null');
    if (raw) result = JSON.parse(raw);
  }
  s.close();

  if (!result) {
    console.error('the viewer never finished the sweep' +
                  (s.logs.length ? '\n  ' + s.logs.join('\n  ') : ''));
    done(1);
    return;
  }
  for (const f of result.fails) console.error('  FAIL ' + f);
  console.log(result.pass
    ? `  passed: ${result.samples} samples, nothing empty, no instance dropped (${result.ms}ms)`
    : `  FAILED: ${result.fails.length} of ${result.samples} samples`);
  done(result.pass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
