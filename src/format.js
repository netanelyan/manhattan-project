// Zero-parse views over the generator's binaries. Nothing here copies or
// decodes: every accessor is a typed-array view straight over the ArrayBuffer.
// Byte layouts are documented in docs/tile-format.md.

export const MAGIC_MASTERS = 0x4d4e544d;   // "MTNM"
export const MAGIC_TILE    = 0x544e544d;   // "MTNT"
export const VERSION       = 1;

export const RECT_TEX_WIDTH = 1024;

export const TILE_KIND = { INSTANCES: 0, BLOCKS: 1 };

// Master record fields, in i32 units within the master table.
export const M_STRIDE = 8;
export const M_RECT_START = 0, M_RECT_COUNT = 1, M_W = 2, M_H = 3,
             M_KLASS = 4, M_ROW_H = 5;

// Group record fields, in u32 units within the group table.
export const G_STRIDE = 4;
export const G_MASTER = 0, G_START = 1, G_COUNT = 2, G_RECTS = 3;

// Instance record: i32 x, i32 y, i32 packed(masterId | orient<<16 | flags<<24).
export const I_STRIDE = 3;

export function viewMasters(buf) {
  const h = new Uint32Array(buf, 0, 8);
  if (h[0] !== MAGIC_MASTERS) throw new Error('masters.bin: bad magic');
  const version = new DataView(buf).getUint16(4, true);
  if (version !== VERSION) throw new Error(`masters.bin: version ${version}`);
  const masterCount = h[2], rectCount = h[3], mastersOff = h[4], rectsOff = h[5];
  return {
    masterCount, rectCount,
    dbuPerMicron: h[6],
    rowHeight: h[7],
    masters: new Int32Array(buf, mastersOff, masterCount * M_STRIDE),
    rects:   new Int32Array(buf, rectsOff,   rectCount * 8),
    bytes: buf.byteLength,
  };
}

export function viewTile(buf) {
  const u32 = new Uint32Array(buf, 0, 16);
  const i32 = new Int32Array(buf, 0, 16);
  if (u32[0] !== MAGIC_TILE) throw new Error('tile: bad magic');
  const dv = new DataView(buf);
  const version = dv.getUint16(4, true);
  if (version !== VERSION) throw new Error(`tile: version ${version}`);

  const kind = dv.getUint16(6, true);
  const t = {
    kind,
    z: dv.getUint8(8),
    groupCount: dv.getUint16(10, true),
    count: u32[3],
    originX: i32[4], originY: i32[5],
    tileSize: i32[6],
    rectCount: u32[7],
    minX: i32[8], minY: i32[9], maxX: i32[10], maxY: i32[11],
    x: u32[14], y: u32[15],
    bytes: buf.byteLength,
  };
  const groupsOff = u32[12], dataOff = u32[13];
  if (kind === TILE_KIND.INSTANCES) {
    t.groups = new Uint32Array(buf, groupsOff, t.groupCount * G_STRIDE);
    t.inst   = new Int32Array(buf, dataOff, t.count * I_STRIDE);
  } else {
    t.blocks  = new Int32Array(buf, dataOff, t.count * 8);
    t.blocksF = new Float32Array(buf, dataOff, t.count * 8);
  }
  return t;
}

export const key = (z, x, y) => `${z}/${x}/${y}`;
