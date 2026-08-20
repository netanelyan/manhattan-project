'use strict';
// The placement index: placements.bin.
//
// One file that makes any single tile at any placement-carrying level
// reproducible on demand, so the deep and mid levels never have to be written.
//
// WHY THIS AND NOT THE TILES. A mid or deep level holds every placement exactly
// once, at 12 bytes each. So each such level is one full copy of the placement
// array - and today's pyramid writes two of them (one mid, one deep), which on
// the 50M design is 1,144 MB of the 1,182 MB total. The index is one copy, at 4
// bytes, and it serves every level. That is the whole saving: not compression,
// deduplication.
//
// LAYOUT. Records are grouped by deepest-level tile, in the exact order
// pyramid.bucketDeepest produces - tile-major, and ascending original index
// within a tile. That is not a detail: a tile built from a range of this file
// must come out byte-identical to one the full generator wrote, and the
// placement order inside a tile is part of those bytes. A coarser level's tile
// covers a 2^(maxZ-z) square of deepest tiles, which is 2^(maxZ-z) contiguous
// ranges here (one per row of the square), read and concatenated in the same
// row-major order collectTile walks them in.
//
// PACKING. A placement's coordinates are stored relative to its own deepest
// tile, so they need only as many bits as the tile is wide - and on the
// placement grid, so they need fewer still. A 61.2um tile on a 200nm site grid
// is 306 columns: 9 bits. 61 rows of 1000nm: 6 bits. 4,634 masters: 13 bits.
// Orientation: 3. That is 31 bits, one 4-byte word, against the 12 bytes the
// tile record needs. The grid is measured from the data and checked, never
// assumed: if any coordinate is off-grid the quantum drops to 1nm, and if the
// packed record will not fit 48 bits the index stores the 12-byte tile record
// verbatim. Both are recorded in the header, so the reader never guesses.
//
// The grid is a property of the coordinate, not of the offset. A tile size need
// not be a multiple of the row height - 38.8um tiles on 1um rows are not - so
// (y - tileOrigin) can be off-grid even when every y is on it. What is stored
// is the difference of the two quantised values, y/gridY - floor(oy/gridY),
// which is exact for any tile size and costs one extra count in the field. It
// is worth spelling out because getting it wrong is silent: the tiles still
// verify, still have consistent content boxes, and are simply in the wrong
// place by less than one tile origin's remainder.

const fs = require('fs');
const path = require('path');
const F = require('./format.js');

const MAGIC_INDEX = 0x504e544d;      // "MTNP"
const HEADER_BYTES = 64;
const PACKED_MAX_BITS = 48;          // Buffer.readUIntLE tops out at 6 bytes

const bitsFor = v => (v <= 1 ? 1 : Math.ceil(Math.log2(v)));

// The largest quantum every coordinate in `vals` is a multiple of, out of the
// candidates offered. Measured, not assumed: a real placement file can and does
// contain off-grid instances, and a wrong quantum here is silent corruption.
function gridOf(vals, n, candidate) {
  if (candidate <= 1) return 1;
  for (let i = 0; i < n; i++) if (vals[i] % candidate !== 0) return 1;
  return candidate;
}

// How a design's placements pack, decided from the design itself.
function planPacking(gen, tileSize, gridXCandidate, gridYCandidate) {
  const { x, y, n } = gen.instances;
  const gridX = gridOf(x, n, gridXCandidate);
  const gridY = gridOf(y, n, gridYCandidate);
  // +2: the field holds a difference of quantised values, which spans one more
  // step than the tile does when the origin does not land on the grid.
  const bitsX = bitsFor(Math.ceil(tileSize / gridX) + 2);
  const bitsY = bitsFor(Math.ceil(tileSize / gridY) + 2);
  const bitsM = bitsFor(gen.masters.length);
  const bits = bitsX + bitsY + bitsM + 3;
  if (bits > PACKED_MAX_BITS) {
    // Nothing packs: fall back to the tile's own placement record, which is
    // what the index would have to hold anyway.
    return { packed: 0, recordBytes: F.INSTANCE_BYTES, gridX: 1, gridY: 1,
             bitsX: 0, bitsY: 0, bitsM: 0, bits: 96 };
  }
  return { packed: 1, recordBytes: Math.ceil(bits / 8), gridX, gridY, bitsX, bitsY, bitsM, bits };
}

// ---------------------------------------------------------------- writing
//
// Written straight out in bucket order, so this is one linear pass over the
// placement array and one linear write. No per-tile buffer, no directory of
// twenty thousand files.
const CHUNK_RECORDS = 1 << 20;       // records per write, so no one buffer is huge

function writeIndex(dir, gen, bucket, pack) {
  const { x, y, m, o, n } = gen.instances;
  const nTiles = bucket.nTiles;
  const rec = pack.recordBytes;
  const buf = Buffer.alloc(HEADER_BYTES + nTiles * 4);

  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, HEADER_BYTES >> 2);
  const i32 = new Int32Array(buf.buffer, buf.byteOffset, HEADER_BYTES >> 2);
  const countsOff = HEADER_BYTES, dataOff = countsOff + nTiles * 4;
  u32[0] = MAGIC_INDEX;
  buf.writeUInt16LE(F.VERSION, 4);
  buf.writeUInt16LE(rec, 6);
  u32[2] = n;
  u32[3] = bucket.tilesPerSide;
  i32[4] = bucket.tileSize;
  i32[5] = pack.gridX;
  i32[6] = pack.gridY;
  buf.writeUInt8(pack.bitsX, 28);
  buf.writeUInt8(pack.bitsY, 29);
  buf.writeUInt8(pack.bitsM, 30);
  buf.writeUInt8(pack.packed, 31);
  u32[8] = countsOff;
  u32[9] = dataOff;

  const counts = new Uint32Array(buf.buffer, buf.byteOffset + countsOff, nTiles);
  for (let t = 0; t < nTiles; t++) counts[t] = bucket.end[t] - bucket.start[t];

  // Streamed in chunks rather than assembled in one buffer: the index is the
  // one artefact whose size tracks the placement count, and a design large
  // enough to need laziness is a design whose index does not fit a Buffer.
  const fd = fs.openSync(path.join(dir, 'placements.bin'), 'w');
  fs.writeSync(fd, buf);
  const chunk = Buffer.alloc(CHUNK_RECORDS * rec);
  const chunk32 = rec === 4 ? new Uint32Array(chunk.buffer, chunk.byteOffset, CHUNK_RECORDS) : null;
  const side = bucket.tilesPerSide, S = bucket.tileSize;
  const shiftY = pack.bitsX, shiftM = pack.bitsX + pack.bitsY, shiftO = shiftM + pack.bitsM;
  const gx = pack.gridX, gy = pack.gridY;
  let k = 0;
  let overflowed = 0;              // any field that did not fit, ORed together
  const maxX = (1 << pack.bitsX) - 1, maxY = (1 << pack.bitsY) - 1;
  const maxM = (1 << pack.bitsM) - 1;
  const flush = () => { if (k) { fs.writeSync(fd, chunk, 0, k * rec); k = 0; } };

  for (let t = 0; t < nTiles; t++) {
    const qx = Math.floor(((t % side) * S) / gx), qy = Math.floor((((t / side) | 0) * S) / gy);
    for (let i = bucket.start[t], e = bucket.end[t]; i < e; i++) {
      const j = bucket.order[i];
      const dx = x[j] / gx - qx, dy = y[j] / gy - qy;
      // Checked, not trusted. A field that silently wraps puts a placement
      // somewhere plausible and wrong, which is the one failure mode this
      // format could have that verification downstream would not notice.
      overflowed |= (dx < 0 || dx > maxX || dy < 0 || dy > maxY || m[j] > maxM) ? 1 : 0;
      if (chunk32) {
        // The common case, and the one worth a fast path: one 32-bit word per
        // record, written through a typed array with integer shifts rather than
        // a Buffer call each. On the 5M design that is the index write going
        // from 1.5s to 0.1s, and it is the only part of the eager pass that
        // scales with the placement count.
        chunk32[k] = dx | (dy << shiftY) | (m[j] << shiftM) | ((o[j] & 7) << shiftO);
      } else if (pack.packed) {
        // Multiplying by a power of two rather than shifting: a 48-bit field
        // does not fit a 32-bit shift, and this is exact up to 2^53.
        chunk.writeUIntLE(dx + dy * 2 ** shiftY + m[j] * 2 ** shiftM + (o[j] & 7) * 2 ** shiftO,
                          k * rec, rec);
      } else {
        chunk.writeInt32LE(x[j], k * rec);
        chunk.writeInt32LE(y[j], k * rec + 4);
        chunk.writeInt32LE((m[j] & 0xffff) | ((o[j] & 0xff) << 16), k * rec + 8);
      }
      if (++k === CHUNK_RECORDS) flush();
    }
  }
  flush();
  fs.closeSync(fd);
  if (overflowed && pack.packed) {
    throw new Error('placements.bin: a placement does not fit the packed record - ' +
                    'the index would be silently wrong, so it is not written');
  }
  return { bytes: dataOff + n * rec, recordBytes: rec, packed: !!pack.packed,
           bits: pack.bits, gridX: pack.gridX, gridY: pack.gridY };
}

// ---------------------------------------------------------------- reading
//
// The header and the per-tile counts are read at open; the records are not. A
// tile needs one contiguous range per row of deepest tiles it covers, so it is
// one positional read each - which is what lets the index be larger than memory
// and still answer a tile in microseconds. The counts are the only part that
// has to be resident, and they are four bytes per deepest tile: 16 MB at a
// 2048x2048 grid, which is where an eleven-billion-placement block lands.
class PlacementIndex {
  constructor(fd, buf) {
    const u32 = new Uint32Array(buf.buffer, buf.byteOffset, HEADER_BYTES >> 2);
    const i32 = new Int32Array(buf.buffer, buf.byteOffset, HEADER_BYTES >> 2);
    if (u32[0] !== MAGIC_INDEX) throw new Error('placements.bin: bad magic');
    const version = buf.readUInt16LE(4);
    if (version !== F.VERSION) throw new Error(`placements.bin: version ${version}, expected ${F.VERSION}`);
    this.fd = fd;
    this.recordBytes = buf.readUInt16LE(6);
    this.count = u32[2];
    this.tilesPerSide = u32[3];
    this.tileSize = i32[4];
    this.gridX = i32[5];
    this.gridY = i32[6];
    this.bitsX = buf.readUInt8(28);
    this.bitsY = buf.readUInt8(29);
    this.bitsM = buf.readUInt8(30);
    this.packed = buf.readUInt8(31) === 1;
    this.dataOff = u32[9];
    const nTiles = this.tilesPerSide ** 2;
    const cbuf = Buffer.alloc(nTiles * 4);
    if (fs.readSync(fd, cbuf, 0, cbuf.length, u32[8]) !== cbuf.length) {
      throw new Error('placements.bin: truncated count table');
    }
    this.counts = new Uint32Array(cbuf.buffer, cbuf.byteOffset, nTiles);
    this.scratch = Buffer.alloc(1 << 16);

    // Prefix sums are built here rather than stored: they are derived, and at
    // 11 billion placements a stored u32 offset would overflow while the
    // counts never do. f64 is exact to 2^53, which is well past any placement
    // count that fits on a disk.
    this.starts = new Float64Array(this.counts.length + 1);
    for (let t = 0; t < this.counts.length; t++) this.starts[t + 1] = this.starts[t] + this.counts[t];
    if (this.starts[this.counts.length] !== this.count) {
      throw new Error('placements.bin: counts do not sum to the placement count');
    }
    const expect = this.dataOff + this.count * this.recordBytes;
    const actual = fs.fstatSync(fd).size;
    if (actual !== expect) throw new Error(`placements.bin: size ${actual}, expected ${expect}`);
  }

  static open(dir) {
    const file = path.join(dir, 'placements.bin');
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(HEADER_BYTES);
    fs.readSync(fd, head, 0, HEADER_BYTES, 0);
    return new PlacementIndex(fd, head);
  }

  close() { try { fs.closeSync(this.fd); } catch { /* already closed */ } }

  countAt(t) { return this.counts[t]; }

  // Decode deepest tile `t` into the SoA arrays at `at`, returning how many
  // were written. World coordinates, because that is what the tile builders
  // take - they subtract their own origin.
  decodeTile(t, out, at) {
    const side = this.tilesPerSide, S = this.tileSize;
    const ox = (t % side) * S, oy = ((t / side) | 0) * S;
    const qx = Math.floor(ox / this.gridX), qy = Math.floor(oy / this.gridY);
    const n = this.counts[t];
    if (n === 0) return 0;
    const rec = this.recordBytes;
    const need = n * rec;
    if (this.scratch.length < need) this.scratch = Buffer.alloc(Math.ceil(need * 1.25));
    const at0 = this.dataOff + this.starts[t] * rec;
    if (fs.readSync(this.fd, this.scratch, 0, need, at0) !== need) {
      throw new Error(`placements.bin: short read for deepest tile ${t}`);
    }
    let p = 0;
    const { x, y, m, o } = out;
    if (this.packed && rec === 4) {
      const maskX = (1 << this.bitsX) - 1, maskY = (1 << this.bitsY) - 1;
      const maskM = (1 << this.bitsM) - 1;
      const shiftY = this.bitsX, shiftM = this.bitsX + this.bitsY;
      const shiftO = shiftM + this.bitsM;
      const gx = this.gridX, gy = this.gridY;
      for (let k = 0; k < n; k++, p += 4) {
        const v = this.scratch.readUInt32LE(p);
        x[at + k] = (qx + (v & maskX)) * gx;
        y[at + k] = (qy + ((v >>> shiftY) & maskY)) * gy;
        m[at + k] = (v >>> shiftM) & maskM;
        o[at + k] = (v >>> shiftO) & 7;
      }
    } else if (this.packed) {
      const py = 2 ** this.bitsY, pm = 2 ** this.bitsM;
      const dxDiv = 2 ** this.bitsX, dyDiv = 2 ** (this.bitsX + this.bitsY);
      const moDiv = 2 ** (this.bitsX + this.bitsY + this.bitsM);
      for (let k = 0; k < n; k++, p += rec) {
        const v = this.scratch.readUIntLE(p, rec);
        const dx = v % dxDiv;
        const dy = Math.floor(v / dxDiv) % py;
        const mm = Math.floor(v / dyDiv) % pm;
        const oo = Math.floor(v / moDiv) & 7;
        x[at + k] = (qx + dx) * this.gridX;
        y[at + k] = (qy + dy) * this.gridY;
        m[at + k] = mm;
        o[at + k] = oo;
      }
    } else {
      for (let k = 0; k < n; k++, p += rec) {
        x[at + k] = this.scratch.readInt32LE(p);
        y[at + k] = this.scratch.readInt32LE(p + 4);
        const packed = this.scratch.readInt32LE(p + 8);
        m[at + k] = packed & 0xffff;
        o[at + k] = (packed >>> 16) & 0xff;
      }
    }
    return n;
  }
}

module.exports = { writeIndex, planPacking, PlacementIndex, MAGIC_INDEX, HEADER_BYTES };
