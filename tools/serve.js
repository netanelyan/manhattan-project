#!/usr/bin/env node
'use strict';
// Static file server for the repo root. ES modules and fetch() need a real
// origin; file:// will not do. Core Node only.
//
//   node tools/serve.js [port]   ->  http://localhost:8080/src/

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +(process.argv[2] || 8080);
const ROOT = path.resolve(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad url');
    return;
  }
  // Scripted-measurement sink: the viewer's ?bench mode posts its numbers here
  // so a headless run can report them without depending on screenshot timing.
  if (rel === '/__log') {
    console.log(new URL(req.url, 'http://x').searchParams.get('msg') || '');
    res.writeHead(204).end();
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    }).end(data);
  });
}).listen(PORT, () => {
  console.log(`serving ${ROOT}\n  viewer  http://localhost:${PORT}/src/\n  data    http://localhost:${PORT}/data/manifest.json`);
});
