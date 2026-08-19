'use strict';
// Chip level: block instances.
//
// The hierarchy is three deep, not two. A master is instanced into a block; a
// block is instanced into the chip. The middle level is the pyramid this
// generator writes; this file is the top one.
//
//   chip   ->  N block instances (x, y, orient)
//   block  ->  the tile pyramid, written once
//   master ->  the cell library in masters.bin
//
// The point is that the block is parsed and tiled ONCE. A chip of 70 copies is
// 70 transforms over the same pyramid, not 70 pyramids: the tiles are fetched
// once and drawn N times. Flattened, the same chip would be N times the bytes.
//
// The transform is the same dihedral set placements already use (N/S/E/W and
// their mirrors), so nothing new enters the format - one more level of the
// instancing that is already there.

const O = { N: 0, S: 1, W: 2, E: 3, FN: 4, FS: 5, FW: 6, FE: 7 };
const ORIENT_NAME = ['N', 'S', 'W', 'E', 'FN', 'FS', 'FW', 'FE'];

// Point maps for a square block of side S, as column-major 2x2 plus an offset:
//
//   x' = m[0]*x + m[2]*y + t[0]*S
//   y' = m[1]*x + m[3]*y + t[1]*S
//
// The offset is what keeps the block's own box at the origin after a flip, so a
// placed instance always occupies [x, x+S] x [y, y+S] whatever its orientation.
const ORIENT_MAP = [
  { m: [1, 0, 0, 1],   t: [0, 0] },   // N
  { m: [-1, 0, 0, -1], t: [1, 1] },   // S
  { m: [0, 1, -1, 0],  t: [1, 0] },   // W
  { m: [0, -1, 1, 0],  t: [0, 1] },   // E
  { m: [-1, 0, 0, 1],  t: [1, 0] },   // FN
  { m: [1, 0, 0, -1],  t: [0, 1] },   // FS
  { m: [0, -1, -1, 0], t: [1, 1] },   // FW
  { m: [0, 1, 1, 0],   t: [0, 0] },   // FE
];

// The transform itself is src/chip.js, shared with the viewer: one
// implementation of block -> chip, used by the generator, the verifier and the
// renderer alike.

// --- synthetic chip: N copies of one block on a grid.
//
// Real repeated blocks abut with a routing channel between them and alternate
// rows are mirrored so power rails meet, which is what 'rows' does. 'none' is
// the translate-only case; 'all' cycles the full dihedral set, which is there
// to prove the transform costs nothing extra rather than because a chip would
// do it.
function buildChip(opts, block) {
  const S = block.world.size;
  const n = opts.blocks;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const gap = Math.round(S * opts.blockGap);
  const pitch = S + gap;

  const instances = [];
  for (let i = 0; i < n; i++) {
    const cx = i % cols, cy = (i / cols) | 0;
    let orient = O.N;
    if (opts.blockOrient === 'rows') orient = (cy & 1) ? O.FS : O.N;
    else if (opts.blockOrient === 'all') orient = i & 7;
    instances.push({ block: 0, x: cx * pitch, y: cy * pitch, orient });
  }

  return {
    version: block.version,
    kind: 'chip',
    name: `synthetic-${n}`,
    blockSize: S,
    chip: { w: cols * pitch - gap, h: rows * pitch - gap },
    grid: { cols, rows, pitch, gap, orient: opts.blockOrient },
    orientNames: ORIENT_NAME,
    blocks: [{ id: 'core', path: '.', world: S, die: block.die, maxZ: block.maxZ }],
    instances,
  };
}

module.exports = { O, ORIENT_NAME, buildChip };
