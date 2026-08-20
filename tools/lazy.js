'use strict';
// Producing a deep or mid tile on demand, from placements.bin.
//
// The contract is byte-identity: a tile this returns must be indistinguishable
// from the one full generation would have written. That is not achieved by
// reimplementing the writers carefully - it is achieved by calling them. The
// only thing this module does is put the placements back in front of
// pyramid.buildDeepTile / buildMidTile in the order collectTile would have
// handed them over, which is why the index stores them in bucket order in the
// first place.
//
// Everything a tile needs is here: the index, masters.bin, the level's tile
// size, and the design's bucket caps. Nothing needs the layout generator, the
// density mips, or any other tile - which is the same property the tile format
// already had, one level up.

const fs = require('fs');
const path = require('path');
const F = require('./format.js');
const P = require('./pyramid.js');
const { PlacementIndex } = require('./pindex.js');

const KIND_ID = { deep: F.TILE_KIND.DEEP, mid: F.TILE_KIND.MID, far: F.TILE_KIND.FAR };

// masters.bin back into the shape pyramid.js expects. It reads .rectCount for
// bucketing, .w/.h for the content box, and nothing else.
function readMasters(dir) {
  const b = fs.readFileSync(path.join(dir, 'masters.bin'));
  const u32 = new Uint32Array(b.buffer, b.byteOffset, 8);
  if (u32[0] !== F.MAGIC_MASTERS) throw new Error('masters.bin: bad magic');
  const count = u32[2], off = u32[4];
  const md = new Int32Array(b.buffer, b.byteOffset + off, count * 8);
  const out = new Array(count);
  for (let m = 0; m < count; m++) {
    out[m] = {
      rectStart: md[m * 8], rectCount: md[m * 8 + 1],
      w: md[m * 8 + 2], h: md[m * 8 + 3],
      klass: md[m * 8 + 4], rowH: md[m * 8 + 5],
    };
  }
  return out;
}

class TileFactory {
  constructor(dir) {
    this.dir = dir;
    this.manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    this.masters = readMasters(dir);
    this.index = PlacementIndex.open(dir);
    this.caps = this.manifest.bucketCaps;
    this.maxZ = this.manifest.maxZ;

    if (this.index.tilesPerSide !== 1 << this.maxZ) {
      throw new Error('placements.bin is not indexed at the manifest maxZ');
    }
    this.levels = new Map();
    for (const L of this.manifest.levels) {
      this.levels.set(L.z, {
        ...L,
        kindId: KIND_ID[L.kind],
        oversize: L.kind === 'far' ? null : P.oversizeMask(this.masters, L.tileSize),
        coverage: Buffer.from(L.coverage, 'base64'),
      });
    }

    // pyramid.js's builders take a gen-shaped object. It only ever reads
    // .masters and .instances, so this is the whole of it.
    this.gen = { masters: this.masters, instances: { x: null, y: null, m: null, o: null, n: 0 } };
    this._grow(1 << 16);
    this.stats = { built: 0, us: 0 };
  }

  _grow(n) {
    if (this.cap >= n) return;
    this.cap = Math.max(n, (this.cap || 0) * 2);
    this.soa = {
      x: new Int32Array(this.cap), y: new Int32Array(this.cap),
      m: new Uint16Array(this.cap), o: new Uint8Array(this.cap),
    };
    this.gen.instances = { ...this.soa, n: this.cap };
    this.idx = new Int32Array(this.cap);
    this.scratch = {
      cnt: new Int32Array(this.caps.length + 1),
      cursor: new Int32Array(this.caps.length),
      sorted: new Int32Array(this.cap),
    };
  }

  // Is this level produced on demand, or was it written up front?
  isLazy(z) {
    const L = this.levels.get(z);
    return !!(L && L.lazy);
  }

  exists(z, x, y) {
    const L = this.levels.get(z);
    if (!L) return false;
    const side = L.tilesPerSide;
    if (x < 0 || y < 0 || x >= side || y >= side) return false;
    const i = y * side + x;
    return ((L.coverage[i >> 3] >> (i & 7)) & 1) === 1;
  }

  // The bytes of tile (z, x, y). Returns null if the level is not one this can
  // produce, or if the coverage bitmap says the tile does not exist.
  build(z, X, Y) {
    const L = this.levels.get(z);
    if (!L || L.kindId === F.TILE_KIND.FAR) return null;
    if (!this.exists(z, X, Y)) return null;
    const t0 = process.hrtime.bigint();

    // The deepest tiles this one covers, walked exactly as collectTile walks
    // them: row-major within the square, and in index order within each.
    const S = 1 << (this.maxZ - z);
    const side = this.index.tilesPerSide;
    let need = 0;
    for (let ty = Y * S, tyEnd = (Y + 1) * S; ty < tyEnd; ty++) {
      for (let tx = X * S, txEnd = (X + 1) * S; tx < txEnd; tx++) {
        need += this.index.countAt(ty * side + tx);
      }
    }
    this._grow(need);

    const oversize = L.oversize;
    const { m } = this.soa;
    let at = 0, n = 0;
    for (let ty = Y * S, tyEnd = (Y + 1) * S; ty < tyEnd; ty++) {
      for (let tx = X * S, txEnd = (X + 1) * S; tx < txEnd; tx++) {
        const t = ty * side + tx;
        const got = this.index.decodeTile(t, this.soa, at);
        for (let k = 0; k < got; k++) {
          if (!oversize[m[at + k]]) this.idx[n++] = at + k;
        }
        at += got;
      }
    }
    if (n === 0) return null;                      // everything here was promoted

    const out = L.kindId === F.TILE_KIND.DEEP
      ? P.buildDeepTile(this.gen, this.idx, n, z, X, Y, L.tileSize, this.scratch, this.caps)
      : P.buildMidTile(this.gen, this.idx, n, z, X, Y, L.tileSize);

    this.stats.built++;
    this.stats.us += Number(process.hrtime.bigint() - t0) / 1000;
    return out.buf;
  }
}

module.exports = { TileFactory, readMasters };
