'use strict';
// Binary layout constants, shared by the generator and documented in
// docs/tile-format.md. Everything is little-endian and 4-byte aligned so the
// viewer can take typed-array views straight over the ArrayBuffer.

// "MTNM" and "MTNT" in file byte order, read back as little-endian uint32.
const MAGIC_MASTERS = 0x4d4e544d;
const MAGIC_TILE    = 0x544e544d;
const VERSION       = 1;

// masters.bin
const M_HEADER_BYTES = 32;
const MASTER_BYTES   = 32;   // 8 x i32
const RECT_BYTES     = 32;   // 8 x i32, consumed as 2 RGBA32I texels

// tiles/{z}/{x}/{y}.bin
const T_HEADER_BYTES = 64;
const GROUP_BYTES    = 16;   // 4 x u32
const INSTANCE_BYTES = 12;   // 3 x i32
const BLOCK_BYTES    = 32;   // 8 x i32/f32

const TILE_KIND = { INSTANCES: 0, BLOCKS: 1 };

// The rect table is uploaded as an RGBA32I texture of this fixed width, so the
// viewer can address rect r at texel 2*r with a shift and a mask.
const RECT_TEX_WIDTH = 1024;

module.exports = {
  MAGIC_MASTERS, MAGIC_TILE, VERSION,
  M_HEADER_BYTES, MASTER_BYTES, RECT_BYTES,
  T_HEADER_BYTES, GROUP_BYTES, INSTANCE_BYTES, BLOCK_BYTES,
  TILE_KIND, RECT_TEX_WIDTH,
};
