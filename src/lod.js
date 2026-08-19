// Which pyramid level to draw at the camera's current zoom.
//
// The generator assigns each level a representation from two numbers - the
// rectangle budget and how many pixels a cell covers (docs/tile-format.md,
// "How the generator assigns kinds"). The viewer chooses its level from the
// same two numbers, so what reaches the screen is what the level was built for.
//
// ONE LADDER, TWO LEVELS OF HIERARCHY. A chip is N instances of a block, and a
// level's cost on screen is summed over the instances the viewport touches. So
// the same rule that picks a level inside one block also picks the chip view:
// zoomed out far enough that dozens of blocks are visible, only the coarsest
// level of each block fits, and that - one merged tile per block - is the chip
// view. There is no separate chip ladder.
//
// SWITCH POINTS ARE DATA. They follow from the design's own tile sizes and the
// p95 rectangle cost of a tile at each level, from how the blocks are placed,
// and from the viewport, which only the viewer knows - rectangles on screen
// scale with viewport area, so a 3440x1440 canvas at dpr 2 costs 5.6x a
// 1920x1080 one at the same zoom. The manifest ships the inputs and the ladder
// solved at a reference viewport; the ladder in force is solved here, against
// the real canvas and the real chip.
//
// HYSTERESIS. A bare threshold makes the level flicker whenever the camera sits
// on it. Each level's switch-in scale is `hysteresis` above its switch-out
// scale, and the whole band sits at or above the scale the level was cleared
// for - so stickiness is only ever spent staying coarse, never on drawing a
// level below the zoom its budget was proved at. One wheel notch is
// exp(0.0015 * 100) = 1.16x, so the band has to be wider than that or a single
// notch could round-trip.

const FAR = 'far';

// What the viewport sees, in the terms the ladder needs. nx, ny and the pitches
// are the block instance geometry; a single block is nx = ny = 1.
export function viewOf(resW, resH, maxTiles, chip) {
  return {
    resW, resH, maxTiles,
    blockW: chip.blockSize, blockH: chip.blockSize,
    nx: chip.nx, ny: chip.ny, pitchX: chip.pitchX, pitchY: chip.pitchY,
    instances: chip.count,
  };
}

// Tiles on screen at a level: the instances a viewport can touch, times the
// tiles of each instance it can touch.
//
// Three caps, and each one matters. A viewport wider than the block pitch
// touches more instances, but never more than exist. A viewport wider than one
// block cannot see more of that block than the block has tiles. And the +1 per
// axis is the partial tile hanging off each edge - not a rounding detail: it is
// why at equal zoom a coarse level draws MORE off-screen geometry than a fine
// one, and so why the ladder has to be forced monotone.
export function tilesOnScreen(view, tilesPerSide, tileSize, scale) {
  const vw = view.resW / scale, vh = view.resH / scale;          // viewport in nm
  const kx = Math.min(view.nx, vw / view.pitchX + 1);
  const ky = Math.min(view.ny, vh / view.pitchY + 1);
  const px = Math.min(tilesPerSide, Math.min(vw, view.blockW) / tileSize + 1);
  const py = Math.min(tilesPerSide, Math.min(vh, view.blockH) / tileSize + 1);
  return { tiles: kx * ky * px * py, instances: kx * ky };
}

export function rectsOnScreen(view, L, scale) {
  const t = tilesOnScreen(view, L.tilesPerSide, L.tileSize, scale);
  return t.tiles * L.rectsPerTile + t.instances * L.overflowRects;
}

// Lowest scale at which f(scale) is within target. f is non-increasing in
// scale, so this is a bisection: the closed form died with the instance caps,
// and a fixed iteration count keeps the result bit-identical between the
// generator and the viewer, which tools/verify.js checks.
const SOLVE_LO = 1e-12, SOLVE_HI = 1e3, SOLVE_ITERS = 64;

export function solveScale(f, target) {
  if (f(SOLVE_LO) <= target) return 0;
  if (f(SOLVE_HI) > target) return Infinity;
  let lo = SOLVE_LO, hi = SOLVE_HI;
  for (let i = 0; i < SOLVE_ITERS; i++) {
    const mid = Math.sqrt(lo * hi);
    if (f(mid) <= target) hi = mid; else lo = mid;
  }
  return hi;
}

// The ladder: one switch-out scale per level, in device px per nm. Three
// constraints, whichever binds hardest:
//
//   budget  this level's tiles across every visible instance, plus their
//           always-resident overflow lists, fit manifest.rectBudget
//   cells   a mean cell spans at least minCellPx, for levels that carry
//           placements - below that an outline is the noise the spike found at
//           full-die zoom, and density blocks carry more
//   tiles   at most maxTiles tiles on screen, the fetch rail
//
// then forced monotone in z, the same way the generator forces kind assignment
// monotone. Monotonicity is not automatic: a finer level of the same kind is
// the cheaper one to draw at equal zoom, so without it the ladder would not
// come out ordered.
export function deriveLadder(manifest, view) {
  const opt = manifest.lod;
  const out = [];
  let floor = 0;
  for (const L of manifest.levels) {
    const e = {
      z: L.z, kind: L.kind, tileSize: L.tileSize, tilesPerSide: L.tilesPerSide,
      rectsPerTile: L.rectP95PerTile || 0,
      overflowRects: L.overflow ? L.overflow.rectCount : 0,
    };
    const budget = e.rectsPerTile > 0
      ? solveScale(s => rectsOnScreen(view, e, s), manifest.rectBudget) : 0;
    const tiles = solveScale(s => tilesOnScreen(view, e.tilesPerSide, e.tileSize, s).tiles, view.maxTiles);
    const cells = L.kind === FAR ? 0 : opt.minCellPx / manifest.meanCellWidth;

    let minScale = Math.max(budget, tiles, cells);
    let bound = minScale === budget ? 'budget' : minScale === tiles ? 'tiles' : 'cells';
    if (minScale < floor) { minScale = floor; bound = 'monotone'; }
    if (out.length === 0) { minScale = 0; bound = 'floor'; }   // something must always draw
    floor = minScale;
    out.push({ ...e, minScale, bound, budget, tiles, cells });
  }
  return out;
}

// Levels no zoom can ever select, dropped to a fixpoint. Used by the generator,
// which is why it lives here: the rule for what is worth writing has to be the
// same rule the viewer selects by, or the pyramid holds levels nothing reads.
//
// After the monotone pass a level can end up sharing its switch-out scale with
// the next finer one, which then takes over the instant either becomes legal -
// the coarser level's window is empty. That is not an edge case; it is the
// normal outcome for the second-deepest level, because a finer level of the
// same kind is genuinely cheaper to draw at equal zoom.
//
// Dropping one lowers the monotone floor for every finer level, which can empty
// another window, so it iterates.
export function selectableLevels(manifest, view) {
  const levels = manifest.levels;
  let keep = levels.map((_, i) => i);
  for (let guard = 0; guard <= levels.length; guard++) {
    const ladder = deriveLadder({ ...manifest, levels: keep.map(i => levels[i]) }, view);
    const drop = new Set();
    for (let k = 0; k + 1 < ladder.length; k++) {
      if (ladder[k + 1].minScale <= ladder[k].minScale) drop.add(k);
    }
    if (!drop.size) return { keep, ladder };
    keep = keep.filter((_, k) => !drop.has(k));
  }
  throw new Error('level selection did not converge');
}

export class LevelPicker {
  constructor(ladder, hysteresis) {
    this.ladder = ladder;
    this.h = hysteresis;
    this.byZ = new Map(ladder.map(p => [p.z, p]));
    this.z = null;                 // nothing on screen yet
  }

  // Finest level whose switch-in scale is met, except that the level already on
  // screen is held until the scale drops below its own switch-out scale.
  pick(scale) {
    // Cold start: there is no level on screen to flicker, so the plain
    // switch-out scale decides. Applying the switch-in scale here would open
    // the viewer at a level coarser than the zoom justifies, and nothing would
    // correct it until the camera moved.
    if (this.z === null) {
      let z = this.ladder[0].z;
      for (const p of this.ladder) if (scale >= p.minScale) z = p.z;
      this.z = z;
      return z;
    }

    let up = this.ladder[0].z;
    for (const p of this.ladder) if (scale >= p.minScale * this.h) up = p.z;
    const cur = this.byZ.get(this.z);
    const hold = cur && scale >= cur.minScale ? this.z : -1;
    this.z = Math.max(up, hold);
    return this.z;
  }

  // Force the state machine to a level - returning to auto after a manual
  // override, so the first pick() holds what is already on screen rather than
  // snapping through it.
  seed(z) { if (this.byZ.has(z)) this.z = z; }

  // What holds this level on screen: [switch-out, switch-in].
  band(z) {
    const p = this.byZ.get(z);
    return p ? [p.minScale, p.minScale * this.h] : [0, 0];
  }

  // Estimated rectangles on screen for a level at a scale - the number the
  // ladder is solved against, for the HUD to show beside the measured one.
  estimate(z, view, scale) {
    const p = this.byZ.get(z);
    return p ? rectsOnScreen(view, p, scale) : 0;
  }
}
