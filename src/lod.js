// Which pyramid level to draw at the camera's current zoom.
//
// The generator assigns each level a representation from two numbers - the
// rectangle budget and how many pixels a cell covers (docs/tile-format.md,
// "How the generator assigns kinds"). The viewer chooses its level from the
// same two numbers, so what reaches the screen is what the level was built for.
//
// SWITCH POINTS ARE DATA. They follow from the design's own tile sizes and the
// p95 rectangle cost of a tile at each level, which the manifest ships, and
// from the viewport, which only the viewer knows - the rectangles on screen
// scale with viewport area, so a 3440x1440 canvas at dpr 2 costs 5.6x a
// 1920x1080 one at the same zoom. So the manifest ships the inputs and the
// ladder is solved here, against the real canvas.
//
// HYSTERESIS. A bare threshold makes the level flicker whenever the camera
// sits on it. Each level's switch-in scale is `hysteresis` above its
// switch-out scale, and the whole band sits at or above the scale the level
// was cleared for - so stickiness is only ever spent staying coarse, never on
// drawing a level below the zoom its budget was proved at. One wheel notch is
// exp(0.0015 * 100) = 1.16x, so the band has to be wider than that or a single
// notch could round-trip.

const FAR = 'far';

// Tiles a viewport covers at a given scale. The +1 per axis is the partial
// tile hanging off each edge - and that is where a coarse level's waste lives:
// at equal zoom a coarse level draws MORE off-screen geometry than a fine one,
// because its edge tiles reach further outside the viewport.
export function tilesOnScreen(resW, resH, tileSize, scale) {
  return (resW / (tileSize * scale) + 1) * (resH / (tileSize * scale) + 1);
}

// Inverse: the lowest scale at which a level of this tile size fits inside an
// allowance of N tiles. Quadratic in u = 1 / (tileSize * scale).
export function scaleForTileAllowance(resW, resH, tileSize, allowance) {
  if (!(allowance > 1)) return Infinity;              // one tile already busts it
  const a = resW * resH, b = resW + resH, c = 1 - allowance;
  const u = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return 1 / (tileSize * u);
}

// The ladder: one switch-out scale per level, in device px per nm. Three
// constraints, whichever binds hardest:
//
//   budget  this level's tiles, plus its always-resident overflow list, fit
//           inside manifest.rectBudget
//   cells   a mean cell spans at least minCellPx, for levels that carry
//           placements - below that an outline is the noise the spike found at
//           full-die zoom, and density blocks carry more
//   tiles   at most maxTiles tiles on screen, the fetch rail
//
// then forced monotone in z, the same way the generator forces kind assignment
// monotone. Monotonicity is not automatic: a finer level of the same kind is
// the *cheaper* one to draw at equal zoom, so without it the ladder would not
// be ordered.
export function deriveLadder(manifest, resW, resH, maxTiles) {
  const opt = manifest.lod;
  const out = [];
  let floor = 0;
  for (const L of manifest.levels) {
    const per = L.rectP95PerTile || 0;
    const room = manifest.rectBudget - (L.overflow ? L.overflow.rectCount : 0);
    const budget = per > 0 ? scaleForTileAllowance(resW, resH, L.tileSize, room / per) : 0;
    const tiles = scaleForTileAllowance(resW, resH, L.tileSize, maxTiles);
    const cells = L.kind === FAR ? 0 : opt.minCellPx / manifest.meanCellWidth;

    let minScale = Math.max(budget, tiles, cells);
    let bound = minScale === budget ? 'budget' : minScale === tiles ? 'tiles' : 'cells';
    if (minScale < floor) { minScale = floor; bound = 'monotone'; }
    if (L.z === 0) { minScale = 0; bound = 'floor'; }    // something must always draw
    floor = minScale;
    out.push({ z: L.z, kind: L.kind, tileSize: L.tileSize, rectsPerTile: per,
               overflowRects: L.overflow ? L.overflow.rectCount : 0,
               minScale, bound, budget, tiles, cells });
  }
  return out;
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
    // the viewer up to a level coarser than the zoom actually justifies, and
    // nothing would correct it until the camera moved.
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
  // z may be null before the first pick.
  band(z) {
    const p = this.byZ.get(z);
    return p ? [p.minScale, p.minScale * this.h] : [0, 0];
  }

  // Estimated rectangles on screen for a level at a scale - the number the
  // ladder is solved against, for the HUD to show beside the measured one.
  estimate(z, resW, resH, scale) {
    const p = this.byZ.get(z);
    if (!p) return 0;
    return tilesOnScreen(resW, resH, p.tileSize, scale) * p.rectsPerTile + p.overflowRects;
  }
}
