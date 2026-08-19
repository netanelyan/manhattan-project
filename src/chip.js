// Chip level: block instances.
//
// The hierarchy is three deep. A master is instanced into a block; a block is
// instanced into the chip. The pyramid in the middle is written once, and the
// chip is a list of transforms over it:
//
//   chip   ->  N block instances (x, y, orient)
//   block  ->  the tile pyramid                     <- tiles/{z}/{x}/{y}.bin
//   master ->  the cell library                     <- masters.bin
//
// Which means a block's tiles are fetched once and drawn N times. The cache
// keys on (z, x, y) inside the block, so N instances of the same block share
// every byte - nothing here touches the store at all.
//
// A viewer with no chip.json runs as a chip of exactly one instance at the
// origin, so there is one code path rather than two.

export const ORIENT_NAME = ['N', 'S', 'W', 'E', 'FN', 'FS', 'FW', 'FE'];

// Point maps for a square block of side S, column-major 2x2 plus an offset in
// units of S. The offset is what puts the block's own box back at the origin
// after a flip, so a placed instance covers [x, x+S] x [y, y+S] whatever its
// orientation - which is what lets culling treat every instance the same.
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

export function transform(inst, blockSize) {
  const o = ORIENT_MAP[inst.orient & 7];
  const m = o.m;
  const tx = inst.x + o.t[0] * blockSize;
  const ty = inst.y + o.t[1] * blockSize;
  const det = m[0] * m[3] - m[1] * m[2];              // always +/-1
  const inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  return {
    m, tx, ty, inv,
    toChipX: (x, y) => m[0] * x + m[2] * y + tx,
    toChipY: (x, y) => m[1] * x + m[3] * y + ty,
    toBlock: (x, y) => {
      const dx = x - tx, dy = y - ty;
      return [inv[0] * dx + inv[2] * dy, inv[1] * dx + inv[3] * dy];
    },
  };
}

// An axis-aligned rect stays axis-aligned under all eight orientations, so the
// viewport maps to a viewport and tile culling runs unchanged inside the block.
export function rectToBlock(T, r) {
  const a = T.toBlock(r.minX, r.minY), b = T.toBlock(r.maxX, r.maxY);
  return {
    minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]),
    maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]),
  };
}

export class Chip {
  constructor(doc, blockSize) {
    this.doc = doc;
    this.blockSize = blockSize;
    this.instances = doc.instances.map((inst, i) => ({
      i, block: inst.block | 0, x: inst.x, y: inst.y, orient: inst.orient & 7,
      T: transform(inst, blockSize),
      box: { minX: inst.x, minY: inst.y, maxX: inst.x + blockSize, maxY: inst.y + blockSize },
    }));
    this.w = doc.chip ? doc.chip.w : blockSize;
    this.h = doc.chip ? doc.chip.h : blockSize;

    // Instance geometry the LOD ladder needs: how many instances a viewport of
    // a given size can touch. Derived from the placements themselves rather
    // than read from doc.grid, because a chip assembled from a DEF need not be
    // a grid and the format should not care where it came from.
    const uniq = a => [...new Set(a)].sort((p, q) => p - q);
    const xs = uniq(this.instances.map(v => v.x)), ys = uniq(this.instances.map(v => v.y));
    const minGap = v => {
      let g = Infinity;
      for (let i = 1; i < v.length; i++) g = Math.min(g, v[i] - v[i - 1]);
      return Number.isFinite(g) ? g : blockSize;
    };
    this.nx = xs.length; this.ny = ys.length;
    this.pitchX = minGap(xs); this.pitchY = minGap(ys);
  }

  get count() { return this.instances.length; }

  // Instances whose box the viewport touches. N is small - a chip is tens to
  // thousands of blocks, not millions - so this is a scan, not an index.
  visible(b) {
    const out = [];
    for (const inst of this.instances) {
      const k = inst.box;
      if (k.maxX < b.minX || k.minX > b.maxX || k.maxY < b.minY || k.minY > b.maxY) continue;
      out.push(inst);
    }
    return out;
  }
}

// A viewer pointed at a block with no chip beside it: one instance, identity.
export function singleInstance(manifest) {
  return new Chip({
    kind: 'chip', name: 'single', blockSize: manifest.world.size,
    chip: { w: manifest.world.size, h: manifest.world.size },
    blocks: [{ id: 'block', path: '.' }],
    instances: [{ block: 0, x: 0, y: 0, orient: 0 }],
  }, manifest.world.size);
}
