// Zero-parse views over the generator's binaries. Nothing here copies or
// decodes: every accessor is a typed-array view straight over the ArrayBuffer.
// Byte layouts are documented in docs/tile-format.md.

export const MAGIC_MASTERS = 0x4d4e544d;   // "MTNM"
export const MAGIC_TILE    = 0x544e544d;   // "MTNT"
export const VERSION       = 4;

export const RECT_TEX_WIDTH = 1024;

// The three LOD representations. A tile is exactly one of them.
export const TILE_KIND = { DEEP: 0, FAR: 1, MID: 2 };
export const KIND_NAME = { 0: 'deep', 1: 'far', 2: 'mid' };

// Master record fields, in i32 units within the master table.
export const M_STRIDE = 8;
export const M_RECT_START = 0, M_RECT_COUNT = 1, M_W = 2, M_H = 3,
             M_KLASS = 4, M_ROW_H = 5;
export const KLASS = { STD: 0, MACRO: 1, PWR: 2, FILL: 3 };

// Bucket table record, in u32 units (deep tiles only).
export const BK_STRIDE = 4;
export const BK_ID = 0, BK_START = 1, BK_COUNT = 2, BK_RECTS = 3;

// Placement record, shared by deep and mid tiles:
//   i32 x, i32 y, i32 packed(masterId | orient<<16 | flags<<24)
export const I_STRIDE = 3;

// Block record (far tiles): i32 x,y,w,h, f32 logic density, i32 layer,
// f32 filler density, i32 spare (the tile slot, at runtime).
export const B_STRIDE = 8;
export const B_DENSITY = 4, B_LAYER = 5, B_FILL = 6, B_SPARE = 7;

// Abstract layers used by mid and far tiles, and by class colouring.
export const LAYER_CELLBOX = 12, LAYER_MACROBOX = 13, LAYER_POWERBOX = 14;
// Class -> abstract layer, for the depth key when colouring by class. Filler
// shares the cell layer: it sits where cells sit, it is only coloured apart.
export const CLASS_LAYER = [LAYER_CELLBOX, LAYER_MACROBOX, LAYER_POWERBOX, LAYER_CELLBOX];

// Draws are grouped by rect-count bucket, so their number is a constant rather
// than a function of library size. The caps are NOT a constant here: they are
// derived per design from its rect-count histogram and shipped in
// manifest.bucketCaps. Deep tiles are written sorted by the bucket those caps
// imply, so the viewer must use exactly the generator's list.
export function bucketOf(rectCount, caps) {
  for (let i = 0; i < caps.length; i++) if (rectCount <= caps[i]) return i;
  return caps.length - 1;
}

export const OVERFLOW_XY = 0xffffffff;

export function viewMasters(buf) {
  const h = new Uint32Array(buf, 0, 8);
  if (h[0] !== MAGIC_MASTERS) throw new Error('masters.bin: bad magic');
  const version = new DataView(buf).getUint16(4, true);
  if (version !== VERSION) throw new Error(`masters.bin: version ${version}, expected ${VERSION}`);
  const masterCount = h[2], rectCount = h[3], mastersOff = h[4], rectsOff = h[5];
  const m = {
    masterCount, rectCount,
    dbuPerMicron: h[6],
    rowHeight: h[7],
    masters: new Int32Array(buf, mastersOff, masterCount * M_STRIDE),
    rects:   new Int32Array(buf, rectsOff,   rectCount * 8),
    bytes: buf.byteLength,
  };
  let maxRects = 0;
  for (let i = 0; i < masterCount; i++) {
    const r = m.masters[i * M_STRIDE + M_RECT_COUNT];
    if (r > maxRects) maxRects = r;
  }
  m.maxRects = maxRects;
  return m;
}

export function viewTile(buf) {
  const u32 = new Uint32Array(buf, 0, 16);
  const i32 = new Int32Array(buf, 0, 16);
  if (u32[0] !== MAGIC_TILE) throw new Error('tile: bad magic');
  const dv = new DataView(buf);
  const version = dv.getUint16(4, true);
  if (version !== VERSION) throw new Error(`tile: version ${version}, expected ${VERSION}`);

  const kind = dv.getUint16(6, true);
  const t = {
    kind,
    z: dv.getUint8(8),
    bucketCount: dv.getUint16(10, true),
    count: u32[3],
    originX: i32[4], originY: i32[5],
    tileSize: i32[6],
    rectCount: u32[7],
    minX: i32[8], minY: i32[9], maxX: i32[10], maxY: i32[11],
    x: u32[14], y: u32[15],
    bytes: buf.byteLength,
  };
  t.isOverflow = t.x === OVERFLOW_XY;
  const bucketsOff = u32[12], dataOff = u32[13];
  if (kind === TILE_KIND.FAR) {
    t.blocks  = new Int32Array(buf, dataOff, t.count * B_STRIDE);
    t.blocksF = new Float32Array(buf, dataOff, t.count * B_STRIDE);
  } else {
    if (kind === TILE_KIND.DEEP) t.buckets = new Uint32Array(buf, bucketsOff, t.bucketCount * BK_STRIDE);
    t.inst = new Int32Array(buf, dataOff, t.count * I_STRIDE);
  }
  return t;
}

// Per-level tile coverage, so the viewer never requests a tile that does not
// exist. Row-major bits, LSB first within each byte.
export function decodeCoverage(b64, tilesPerSide) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return (x, y) => {
    if (x < 0 || y < 0 || x >= tilesPerSide || y >= tilesPerSide) return false;
    const i = y * tilesPerSide + x;
    return ((bytes[i >> 3] >> (i & 7)) & 1) === 1;
  };
}

export const key = (z, x, y) => `${z}/${x}/${y}`;
export const overflowKey = z => `${z}/ovf`;
