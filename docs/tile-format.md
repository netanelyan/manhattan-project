# Tile format

The on-disk format the generator (`tools/gen.js`) writes and the viewer (`src/`)
reads. Design rule: **the viewer parses nothing.** Every bulk array is read as a
typed-array view straight over the fetched `ArrayBuffer` and handed to
`bufferData` or `texImage2D` unmodified.

This document is the contract. A producer that emits these bytes — a DEF parser,
a GDS tiler, anything — works with the existing viewer unchanged.

Format version **4**. `version` appears in both file headers and in
`chip.json`, and the viewer rejects a mismatch.

| version | change |
|---|---|
| 1 | deep tiles only |
| 2 | three LOD representations (deep / mid / far) |
| 3 | deep tiles sort by rect-count bucket, not by master; per-level overflow lists |
| 4 | a far block record carries two density channels, logic and filler, in the word that used to hold a sub-kind redundant with the layer id |

## Conventions

- **Little-endian** throughout. No big-endian fallback.
- **Integer nanometres** for all coordinates. `dbuPerMicron` is carried in the
  header, but the generator always uses 1000.
- **4-byte alignment.** Every array starts at an offset divisible by 4 and every
  record is a whole number of 4-byte words, so `new Int32Array(buf, off, n)`
  never throws.
- Field tables give byte offsets from the start of the record.
- `u8`/`u16`/`u32`/`i32`/`f32` are the obvious C types.

## File tree

```
data/
  chip.json              block instances: the chip, as a list of transforms
  manifest.json          bootstrap metadata for one block, the only text file
  masters.bin            cell master library, fetched once, resident forever
  tiles/{z}/{x}/{y}.bin  quadtree pyramid for one block, one file per tile
```

Everything below `chip.json` describes **one block**. The chip is N instances
of it, placed and oriented - see "Block instances: the chip level".

Tile `(z, x, y)` covers world nm `[x·S, (x+1)·S) × [y·S, (y+1)·S)` where
`S = world.size / 2^z`. `world.size` is an exact multiple of `2^maxZ`, so `S` is
a whole number of nanometres at every level and tile origins are exact.

**Every tile is independently renderable given only `masters.bin`.** No tile
references another tile.

---

## The three representations

The pyramid does not decimate; it changes representation. Dropping small masters
from a mid level would punch holes in cells that are still large enough to see,
so instead each level carries whichever of three forms is right for its zoom:

| kind | id | payload | rects per placement | draw calls |
|---|---|---|---|---|
| **deep** | 0 | placements + master group table | ~11 (library dependent) | one per master |
| **mid** | 2 | placements, drawn as cell outlines | 1 | one per visible set |
| **far** | 1 | merged density blocks, not placements | n/a | one per visible set |

Deep and mid share a byte-identical placement record. The difference is that a
mid tile has no group table, and the viewer draws each placement as its master's
bounding box — resolved from the resident master table, never touching the rect
geometry. Cell internals only matter at the deepest level or two; above that an
outline is all the pixels can carry, and below `MIN_CELL_PX` even an outline is
subpixel and blocks carry more information than geometry does.

### How the generator assigns kinds

For each level, with `p95` the 95th-percentile placement count over non-empty
tiles at that level and `visT = min(4^z, VIS_TILES)`:

```
cellPx   = meanCellWidth · TILE_PX / tileSize(z)
deepCost = visT · p95 · meanRectsPerPlacement
midCost  = visT · p95

deep  if  (maxZ - z) < MAX_DEEP  and  deepCost <= RECT_BUDGET
mid   if  midCost <= RECT_BUDGET  and  cellPx >= MIN_CELL_PX
far   otherwise
```

then forced monotone: once a level is abstract, no coarser level goes back to a
more detailed form. Constants live in `tools/format.js`:

| constant | value | why |
|---|---|---|
| `RECT_BUDGET` | 2,000,000 | measured draw ceiling, `docs/renderer-findings.md` |
| `VIS_TILES` | 32 | tiles a 3440×1440 viewport covers at `TILE_PX` |
| `TILE_PX` | 512 | nominal on-screen size of one tile |
| `MIN_CELL_PX` | 1.5 | below this an outline is subpixel mud |
| `MAX_DEEP` | 2 | internals only matter at the deepest levels |
| `BLOCK_GRID` | 32 | density blocks per side, per far tile |

**The budget is counted in rectangles, not placements.** The spike drew one rect
per instance, so its ~2M figure is a rectangle ceiling. At ~11 rects per
placement a deep level saturates at ~180k placements, while a mid level at one
rect each holds the full 2M. Every tile header carries `rectCount` so a consumer
can budget on the number that actually costs.

Worked example, a 501,886-placement design (`--count 500k`):

| z | kind | tiles | tile size | p95/tile | cell px | est. rects on screen |
|---|---|---|---|---|---|---|
| 0 | far | 1 | 739.2 µm | 501,886 | 0.45 | 32×32 blocks |
| 1 | far | 4 | 369.6 µm | 137,124 | 0.91 | 32×32 blocks |
| 2 | mid | 16 | 184.8 µm | 38,752 | 1.81 | 620,032 |
| 3 | mid | 64 | 92.4 µm | 9,911 | 3.63 | 317,152 |
| 4 | deep | 256 | 46.2 µm | 2,562 | 7.26 | 903,392 |

---

## `masters.bin`

The cell master library: ~400 unique cell types, each a list of rectangles in
cell-local nanometres. A design with 10M placements still has only these ~400
shapes.

### Header (32 bytes)

| off | type | field | notes |
|---|---|---|---|
| 0 | u32 | `magic` | `0x4D4E544D`, i.e. `"MTNM"` in file byte order |
| 4 | u16 | `version` | 2 |
| 6 | u16 | — | reserved, 0 |
| 8 | u32 | `masterCount` | |
| 12 | u32 | `rectCount` | total across all masters |
| 16 | u32 | `mastersOff` | byte offset of the master table (32) |
| 20 | u32 | `rectsOff` | byte offset of the rect table |
| 24 | u32 | `dbuPerMicron` | 1000 |
| 28 | u32 | `rowHeight` | standard cell row height in nm |

### Master record (32 bytes, 8 × i32)

| off | type | field | notes |
|---|---|---|---|
| 0 | i32 | `rectStart` | index into the rect table |
| 4 | i32 | `rectCount` | |
| 8 | i32 | `w` | bounding box width, nm |
| 12 | i32 | `h` | bounding box height, nm |
| 16 | i32 | `klass` | 0 = standard cell, 1 = macro, 2 = power strap |
| 20 | i32 | `rowH` | site row height, 0 for non-row cells |
| 24 | i32 | — | reserved |
| 28 | i32 | — | reserved |

Every rect of a master lies inside `[0,w) × [0,h)`. `tools/verify.js` enforces
this; the orientation transforms assume it. `w`/`h` are also what mid tiles draw,
so they must be the true abstract outline, not a loose bound.

### Rect record (32 bytes, 8 × i32)

| off | type | field | notes |
|---|---|---|---|
| 0 | i32 | `x` | cell-local nm |
| 4 | i32 | `y` | |
| 8 | i32 | `w` | > 0 |
| 12 | i32 | `h` | > 0 |
| 16 | i32 | `layer` | see layer table |
| 20 | i32 | `flags` | bit 0 = pin, bit 1 = obstruction |
| 24 | i32 | — | reserved |
| 28 | i32 | — | reserved |

**Why 32 bytes.** The rect table is uploaded verbatim as an `RGBA32I` texture
1024 texels wide: each rect is exactly **two texels**, so rect `r` lives at texel
`2r`, addressed as `ivec2(t & 1023, t >> 10)`. The vertex shader turns
`gl_VertexID` into `(rect index, quad corner)` and `texelFetch`es the geometry.
That is why there are no per-master vertex buffers and no CPU-side geometry
expansion: the rect table goes to the GPU as-is, padded only to fill the last
texture row.

### Layers

| id | name | id | name |
|---|---|---|---|
| 0 | outline | 8 | metal3 |
| 1 | nwell | 9 | pin |
| 2 | diff | 10 | macro |
| 3 | poly | 11 | power |
| 4 | contact | 12 | cellbox *(abstract)* |
| 5 | metal1 | 13 | macrobox *(abstract)* |
| 6 | via1 | 14 | powerbox *(abstract)* |
| 7 | metal2 | 15 | reserved |

0–11 appear in master rects (deep tiles). 12–14 are synthesised by mid and far
tiles and never appear in `masters.bin`.

The layer id doubles as the depth key: the vertex shader emits `z = 1 - layer/16`
and the depth test does the sorting. Draw order is therefore free, which is what
lets draws be grouped by master rather than by layer. See
[Known constraints](#known-constraints) — this buys ordering at the cost of
transparency.

---

## `tiles/{z}/{x}/{y}.bin`

All three kinds share one 64-byte header. `kind` selects the payload.

### Header (64 bytes)

| off | type | field | notes |
|---|---|---|---|
| 0 | u32 | `magic` | `0x544E544D`, i.e. `"MTNT"` |
| 4 | u16 | `version` | 2 |
| 6 | u16 | `kind` | 0 = deep, 1 = far, 2 = mid |
| 8 | u8 | `z` | |
| 9 | u8 | — | reserved |
| 10 | u16 | `bucketCount` | rect-count buckets; 0 for mid and far |
| 12 | u32 | `count` | placements, or blocks |
| 16 | i32 | `originX` | world nm of the tile's min corner |
| 20 | i32 | `originY` | |
| 24 | i32 | `tileSize` | tile extent in nm (square) |
| 28 | u32 | `rectCount` | rectangles this tile submits |
| 32 | i32 | `contentMinX` | tile-local bbox of geometry actually drawn |
| 36 | i32 | `contentMinY` | |
| 40 | i32 | `contentMaxX` | |
| 44 | i32 | `contentMaxY` | |
| 48 | u32 | `bucketsOff` | byte offset of the bucket table (64) |
| 52 | u32 | `dataOff` | byte offset of the record array |
| 56 | u32 | `tx` | |
| 60 | u32 | `ty` | |

`rectCount` is the tile's true GPU cost: `Σ master.rectCount` for deep, `count`
for mid and far. LOD selection sums it over candidate tiles.

`contentMin/Max` bounds the geometry a tile actually draws, which for deep and
mid extends past `tileSize` — see [Content bleed](#content-bleed). Viewport
culling must test the content box, not the tile box. For far tiles the content
box always equals the tile box, because block geometry is clipped.

### Deep payload (`kind == 0`)

Bucket table at `bucketsOff`, `bucketCount` records of 16 bytes:

| off | type | field | notes |
|---|---|---|---|
| 0 | u32 | `bucketId` | index into `bucketCaps`; strictly ascending |
| 4 | u32 | `start` | first placement index; buckets are contiguous from 0 |
| 8 | u32 | `count` | > 0 |
| 12 | u32 | `rectCount` | actual `Σ master.rectCount` for the bucket |

Then the placement array (below), **sorted by rect-count bucket** so each bucket
is one contiguous slice.

**Why buckets and not masters.** Version 2 sorted by master id so the viewer
could issue one draw call per master. Measured against a 4,634-master library,
a visible set of only 25 tiles already touches 3,619 distinct masters and
49 tiles touches 4,395 - the union saturates the library almost immediately, so
the draw count *is* the library size. ~4,600 draw calls does not fit a 16.7 ms
frame, and real libraries are larger still.

Bucketing makes the draw count a constant. A master belongs to the first bucket
whose cap is at least its rect count:

```
BUCKET_CAPS = [8, 16, 32, 64]
bucketOf(r) = first i with r <= BUCKET_CAPS[i], else BUCKET_CAPS.length
```

The trailing bucket only exists if some master exceeds the last fixed cap; its
cap is then the library maximum. `manifest.bucketCaps` states the resolved list.

Each instance carries its own master id, and the vertex shader looks the
geometry up in the master table texture, so **one draw call covers every master
in the bucket**. The draw issues `6 × cap` vertices per instance; a master with
fewer rects collapses the surplus to degenerate triangles.

That surplus is the cost. Measured on this generator:

| visible set | actual rects | submitted rects | padding |
|---|---|---|---|
| 25 deep tiles, 5M design | 332,417 | 573,488 | +73% |
| 49 deep tiles, 500k design | 1,175,419 | 1,900,480 | +62% |

Higher than a first estimate would suggest, because the placement mix is
lopsided: 61.5% of placements have exactly 9 rects and 23.1% have 10, so the
cap-16 bucket is a poor fit for most of the design. Padding eats the rectangle
budget - 1.9M submitted against a 2M ceiling for only 1.2M real rectangles.

Bucket granularity is the knob, and draw calls are cheap enough now that
spending a few more is nearly free. Measured over one design's full placement
list:

| caps | draw calls | padding | submitted |
|---|---|---|---|
| `[8, 16, 32, 64]` | 4 | 38.1% waste | 8.91M |
| `[8, 12, 16, 24, 32, 48, 64]` | 7 | 20.0% waste | 6.90M |
| `[10, 12, 14, 16, 24, 32, 48, 64]` | 8 | 7.6% waste | 5.98M |
| `[8, 10, 12, 14, 16, 20, 24, 32, 48, 64]` | 10 | 6.6% waste | 5.91M |

The shipped value is `[8, 16, 32, 64]`. Changing it is one constant in
`tools/format.js` and `src/format.js`, and requires regenerating.

`WEBGL_multi_draw` is probed at startup and reported in the HUD, but not used.
It would collapse draw calls too, but it needs an extension, and it would not
give the other half of what bucketing gives: a small fixed set of *buffers*,
one per bucket, which is what makes persistent slot allocation practical.

### Mid payload (`kind == 2`)

The placement array alone. No bucket table (`bucketCount == 0`,
`dataOff == bucketsOff`), and no requirement on ordering — the whole tile draws in
one call. The viewer resolves each placement's `w`/`h` from the master table and
its colour from `master.klass` (std → cellbox, macro → macrobox, power →
powerbox). The rect table is never read.

### Placement record (12 bytes) — deep and mid

| off | type | field | notes |
|---|---|---|---|
| 0 | i32 | `x` | tile-local nm, in `[0, tileSize)` |
| 4 | i32 | `y` | tile-local nm, in `[0, tileSize)` |
| 8 | u16 | `masterId` | |
| 10 | u8 | `orient` | LEF orientation, 0..7 |
| 11 | u8 | `flags` | reserved, 0 |

Bytes 8..11 are read as one `i32`: `masterId = w & 0xffff`,
`orient = (w >>> 16) & 0xff`, `flags = w >>> 24`.

Orientations, applied to master bbox `W × H` and rect `(x, y, w, h)`:

| id | name | transformed rect |
|---|---|---|
| 0 | N | `(x, y, w, h)` |
| 1 | S | `(W-x-w, H-y-h, w, h)` |
| 2 | W | `(H-y-h, x, h, w)` |
| 3 | E | `(y, W-x-w, h, w)` |
| 4 | FN | `(W-x-w, y, w, h)` |
| 5 | FS | `(x, H-y-h, w, h)` |
| 6 | FW | `(H-y-h, W-x-w, h, w)` |
| 7 | FE | `(y, x, h, w)` |

Rotated orientations (2, 3, 6, 7) swap the placed bounding box to `H × W`; mid
tiles and content boxes must account for that. The generator emits only N and FS
for standard cells (rows alternate so power rails abut) and N for macros and
straps; the shader implements all eight.

### Far payload (`kind == 1`)

Merged aggregate geometry, `count` records of 32 bytes. No bucket table.

| off | type | field | notes |
|---|---|---|---|
| 0 | i32 | `x` | tile-local nm |
| 4 | i32 | `y` | |
| 8 | i32 | `w` | |
| 12 | i32 | `h` | |
| 16 | f32 | `density` | logic area as a fraction of the block, in `[0, 1]` |
| 20 | i32 | `layer` | 12 cellbox, 13 macrobox, 14 powerbox |
| 24 | f32 | `fill` | filler and decap area, same units |
| 28 | i32 | — | reserved (the viewer writes the tile slot here) |

A far tile holds three things:

- a `BLOCK_GRID × BLOCK_GRID` grid of **density blocks** covering standard cell
  area, blocks below 0.4% coverage omitted;
- **macro blocks**, one per macro overlapping the tile;
- **power blocks**, strap segments coalesced into long runs.

Density comes from a mip chain: the finest far level bins cell area into a
`BLOCK_GRID · 2^zFarMax` raster, and coarser levels are 2×2 averages of it.

**Two channels, because occupied and useful are different questions.** Logic
area and filler area are binned separately. A region packed with decaps is full
and doing nothing, and a single "how full is this" number calls it busy — which
is one of the ways a full-die view turns into a wash. The second channel costs
nothing: the record had a spare word, and the sub-kind word it replaced was
redundant with `layer`.

Keeping macros and the power grid as sharp objects rather than averaging them
into the field is the rest of it. Averaging everything is precisely the uniform
grey the spike found at fit-to-die zoom; a density gradient with macro blocks
and a visible power grid is a readable map.

#### What the viewer does with it

A single hue scaled by density is the mud again: a design running 28–56% logic
density spends its whole range in one part of one ramp, and every region comes
out the same colour. So:

- the ramp walks **hue as well as lightness** — deep blue, teal, green, yellow,
  orange — so neighbouring densities are distinguishable rather than merely
  ordered;
- it is stretched across `manifest.densityRange`, the design's own p5..p95 logic
  density, instead of `[0, 1]`, which is where the contrast comes from;
- **dead area leaves the ramp**: as filler comes to dominate a block's occupied
  area, its colour is mixed toward a flat grey, so "full of decap" cannot be
  mistaken for "full of logic".

The colour is independent of the depth key, so colouring by cell class does not
disturb painting order.

**On the synthetic data the filler channel is nearly flat, and that is a
property of the generator, not of the format.** Filler here is drawn from the
same global usage distribution as logic, so it is spread evenly at ~30% of
placements; a real design fills whatever the placer left, so filler concentrates
exactly where utilisation is low. On this data the *logic* channel carries the
regional signal and sparse regions read blue. Making the generator fill leftover
row space was tried and reverted: it is the faithful model, but it resizes the
die (occupancy stops being the density mean), moves every switch point, and
changes which levels are worth writing — a placement-model decision worth taking
deliberately rather than as a side effect of a rendering change.

**Unlike placements, block geometry is clipped to tile bounds.** Aggregates may
be split across tiles because they carry no identity — a macro appearing as four
clipped rectangles in four tiles draws identically to one rectangle. That is why
far tiles have zero bleed.

---

## `manifest.json`

Bootstrap metadata. The only file parsed as text, fetched once.

```json
{
  "version": 4,
  "seed": 42,
  "dbuPerMicron": 1000,
  "rowHeight": 1000,
  "siteWidth": 200,
  "die":   { "w": 2473800, "h": 2474000 },
  "world": { "size": 2483200 },
  "maxZ": 6,
  "instanceCount": 4990711,
  "masterCount": 4634,
  "rectCount": 95784,
  "rectTexWidth": 1024,
  "meanRectsPerInstance": 8.85,
  "blockGrid": 32,
  "densityRange": [0.2763, 0.5612],
  "rectBudget": 2000000,
  "bucketCaps": [3, 5, 9, 10, 14, 24, 32, 44],
  "meanCellWidth": 714,
  "lod": {
    "refView": { "w": 3440, "h": 1440 },
    "minCellPx": 1.5,
    "maxVisibleTiles": 128,
    "hysteresis": 1.3,
    "solvedFor": {
      "instances": 70, "nx": 9, "ny": 8,
      "pitchX": 2508032, "pitchY": 2508032,
      "blockW": 2483200, "blockH": 2483200
    },
    "switchPoints": [
      { "z": 0, "bound": "floor",  "minScale": 0 },
      { "z": 1, "bound": "tiles",  "minScale": 0.000193828 },
      { "z": 2, "bound": "tiles",  "minScale": 0.000502048 },
      { "z": 3, "bound": "tiles",  "minScale": 0.00117345 },
      { "z": 4, "bound": "budget", "minScale": 0.00266 },
      { "z": 6, "bound": "tiles",  "minScale": 0.00653645 }
    ],
    "shadowed": [5]
  },
  "bucketPadding": 0.0204,
  "oversizeFrac": 0.25,
  "maxRectsPerMaster": 44,
  "strapAligned": false,
  "partial": false,
  "levels": [
    {
      "z": 6,
      "kind": "deep",
      "tilesPerSide": 64,
      "tileSize": 38800,
      "tileCount": 3725,
      "recordBytes": 12,
      "rectTotal": 44044448,
      "p95PerTile": 1662,
      "rectP95PerTile": 14752,
      "maxBuckets": 8,
      "maxOverhang": 6200,
      "overflow": { "count": 9609, "rectCount": 9749, "bytes": 115404 },
      "coverage": "…base64…"
    }
  ]
}
```

The design above is `make dev`'s default: 4,990,711 placements over a 4,634-master
library. A lazily generated design carries one extra key, `lazy`, described under
"placements.bin"; it is absent rather than null on a full run.

- `partial` is true when `--one-tile` was used and only a slice exists.
- **`levels` can have gaps.** A level that no zoom can ever select is not
  written, so `z` is not a dense range; `lod.shadowed` lists what was skipped.
  Consumers must step through the levels that exist rather than assuming that
  `z-1` is one of them.
- `maxOverhang` is the furthest any tile at this level draws outside its own
  bounds. The viewer expands its cull rect by it, which makes tile-granularity
  culling exact despite bleed. Overflow promotion is what keeps it to one
  standard cell.
- `overflow` describes `tiles/{z}/overflow.bin`, or is `null` if the level has
  none. Far levels never have one - their geometry is clipped.
- `bucketCaps` is the resolved bucket cap list for this library; a consumer must
  agree with it or deep tiles will draw wrong.
- `p95PerTile` is the 95th-percentile *placement* count over this level's
  non-empty tiles, the number the generator planned kinds from.
  `rectP95PerTile` is the same percentile of what a tile actually costs to
  draw, taken over the tiles as written, and it is what the runtime level
  choice budgets against.
- `densityRange` is the p5 and p95 of logic density over the finest far level's
  non-empty blocks. It is the interval the viewer stretches its density ramp
  across; a ramp over `[0, 1]` on a design that occupies a fifth of that range
  is a flat wash.
- `lod.solvedFor` is the block instance geometry the shipped ladder was solved
  for: instance count, distinct positions per axis, pitch, block size. A viewer
  with a different `chip.json` re-solves; this is what makes the shipped numbers
  reproducible, and `tools/verify.js` checks them against it.
- `lod.shadowed` lists levels the generator planned and then did not write,
  because the next finer level takes over at the same scale.
- `lod` holds the level-choice policy plus the ladder solved at `refView`.
  `switchPoints[z].minScale` is the lowest camera scale, in device px per nm,
  at which level `z` may be drawn, and `bound` names the constraint that set
  it. A viewer with a different canvas re-solves from `tileSize`,
  `rectP95PerTile`, `overflow` and `rectBudget`; see "Choosing a level at
  runtime". One entry per level, ascending `z`, monotone.
- `coverage` is a base64 row-major bitmap, bit `ty · tilesPerSide + tx`, LSB
  first within each byte. A set bit means the file exists. This is what stops the
  viewer requesting tiles that were never written — cheaper than listing 16k
  coordinates and it keeps empty regions free.

Levels appear in ascending `z`. Consumers should key on `z`, not array index.

---

## Overflow lists

Placements are bucketed into a tile by their **origin corner**, never clipped,
so a placement whose origin sits just inside a tile edge draws past it. Culling
has to expand its query rect by the level's worst overhang, so one oversized
feature makes the viewer fetch an enormous ring of neighbours. Version 2
measured this and it was severe, growing with design size:

| design | deepest level | tile | bleed | candidate tiles | should be | inflation |
|---|---|---|---|---|---|---|
| 500k | z4 | 46.2 µm | 123 µm | 42 | 16 | ×2.6 |
| 5M | z6 | 36.6 µm | 427 µm | 240 | 16 | ×15.0 |
| 50M | z7 | 57.8 µm | 1410 µm | 812 | 16 | ×50.8 |

Macro size scales with `sqrt(placements)` while deepest-tile size stays roughly
constant, so the ratio compounds on exactly the designs that matter.

**Version 3 promotes oversized features out of the tile grid.** A placement
wider or taller than `OVERSIZE_FRAC` (0.25) of its level's tile size is not
written to a tile at all. It goes to that level's overflow list:

```
tiles/{z}/overflow.bin
```

which is a normal tile file with `tx == ty == 0xFFFFFFFF`, `originX/Y == 0` and
`tileSize == world.size`. It carries the same representation as its level - a
deep level's overflow list has a bucket table, a mid level's does not - so the
viewer renders it through exactly the same path, as one more resident tile.

The viewer loads a level's overflow list once, alongside the level, and keeps it
resident. It is small: the features that are oversized at any level are macros
and long power straps, and there are few of them.

The result, same generator and seeds:

| design | level | bleed before | bleed after | overflow entries |
|---|---|---|---|---|
| 500k | z2 mid | 122.8 µm | **3.8 µm** | 6 |
| 500k | z3 mid | 122.8 µm | **3.8 µm** | 426 |
| 500k | z4 deep | 122.8 µm | **3.8 µm** | 426 |
| 5M | z4 mid | 385.6 µm | **3.8 µm** | 6 |
| 5M | z6 deep | 427.0 µm | **3.8 µm** | 5,802 |

3.8 µm is one standard cell of the 400-master library those runs used - the
residual bleed of a 4 µm master against a 0.25 threshold - and the point is that
it no longer grows with design size.

Today's defaults measure a little higher, for two reasons worth naming rather
than rounding away:

| design | level | tile | bleed | overflow entries |
|---|---|---|---|---|
| 500k | z2 mid | 196.0 µm | 19.0 µm | 5 |
| 500k | z3 mid | 98.0 µm | 6.2 µm | 935 |
| 500k | z4 deep | 49.0 µm | 6.2 µm | 935 |
| 5M | z4 mid | 155.2 µm | 24.8 µm | 5 |
| 5M | z6 deep | 38.8 µm | 6.2 µm | 9,609 |

- **6.2 µm is one decap.** The library is now 4,634 masters matching a real
  `cells.lef`, and its widest filler is 32 sites - 6.4 µm - which is under the
  0.25 threshold at every tile size here and so stays in its tile. A placement
  200 nm inside a tile edge bleeds 6.2 µm past it. That is the floor, and it is
  a property of the library, not of the pyramid.
- **The mid rows are a power strap.** An unaligned strap segment is 25 µm long,
  which is oversized at a deep tile and promoted, but inside the 0.25 threshold
  of a mid tile - so it stays, and bleeds by however much of its length crosses
  the edge. That is also why the mid overflow lists hold 5 entries, the macros,
  while the deep ones hold thousands: the straps are only oversized down there.

`--strap-align` sizes strap segments to one deepest-level tile and snaps them to
tile boundaries, which removes that: the 5M design's mid bleed drops from
24.8 µm to 6.2 µm and its deep overflow list from 9,609 entries to 6,179. Real
tilers split long wires at tile borders for the same reason, so it is a
legitimate thing to do - but it is **off by default on purpose**. With it on,
nothing in the design straddles a deep tile edge except macros, and the overflow
path goes untested against the kind of geometry a real parser will hand it.

Two invariants hold, and `tools/verify.js` enforces both:

- Nothing is lost: tiles plus overflow are still a complete copy of the
  placement list at every deep and mid level.
- Nothing is duplicated: a placement is in a tile *or* in the overflow list,
  never both. The size test is a pure function of the master, so the two sets
  partition exactly.

## Block instances: the chip level

The hierarchy is three deep, not two:

```
chip    ->  N block instances (block, x, y, orient)     chip.json
block   ->  the tile pyramid                            tiles/{z}/{x}/{y}.bin
master  ->  the cell library                            masters.bin
```

A block is parsed and tiled **once**. A chip that places it 70 times is 70
transforms over that one pyramid — the same instancing the format already plays
with masters, one level up. The 4,990,711-placement block instanced 70 times is
349,349,770 placements at chip level; flattened it would be ~8.2 GB of tiles,
instanced it is the block's 117 MB and a 70-entry list.

The viewer takes the chip as a manifest and does not care where the manifest
came from — a chip-level DEF, an assembly script, or a person writing it by
hand. A viewer pointed at a block with no `chip.json` beside it runs as a chip
of exactly one instance at the origin, so there is one code path, not two.

### `chip.json`

```json
{
  "version": 4,
  "kind": "chip",
  "name": "synthetic-70",
  "blockSize": 2483200,
  "chip": { "w": 22547456, "h": 20039424 },
  "grid": { "cols": 9, "rows": 8, "pitch": 2508032, "gap": 24832, "orient": "rows" },
  "orientNames": ["N", "S", "W", "E", "FN", "FS", "FW", "FE"],
  "blocks": [
    { "id": "core", "path": ".", "world": 2483200, "die": { "w": 2473800, "h": 2474000 }, "maxZ": 6 }
  ],
  "instances": [
    { "block": 0, "x": 0, "y": 0, "orient": 0 },
    { "block": 0, "x": 2508032, "y": 0, "orient": 0 }
  ]
}
```

- `instances` is the whole of it: a block index, a position in chip nanometres,
  and one of the eight orientations. 16 bytes of meaning per instance, against
  the tens of gigabytes it stands for.
- `blocks[i].path` is where that block's `manifest.json`, `masters.bin` and
  `tiles/` live, relative to `chip.json`. The synthetic chip points every
  instance at the one block it was generated from.
- `grid` is how the synthetic chip was laid out and is *not* read by the
  viewer — it re-derives instance pitch from the placements themselves, because
  a chip assembled from a DEF need not be a grid.
- The block's own `manifest.json` is untouched by any of this. A block does not
  know how many times it is placed.

### The transform

Orientation is the same eight-element set placements already use — N, S, E, W
and their mirrors — so nothing new enters the format. Each is a point map on a
square block of side `S`, written as a column-major 2×2 and an offset in units
of `S`:

| orient | x' | y' | m | t |
|---|---|---|---|---|
| N | x | y | `1,0,0,1` | `0,0` |
| S | S−x | S−y | `-1,0,0,-1` | `1,1` |
| W | S−y | x | `0,1,-1,0` | `1,0` |
| E | y | S−x | `0,-1,1,0` | `0,1` |
| FN | S−x | y | `-1,0,0,1` | `1,0` |
| FS | x | S−y | `1,0,0,-1` | `0,1` |
| FW | S−y | S−x | `0,-1,-1,0` | `1,1` |
| FE | y | x | `0,1,1,0` | `0,0` |

The offset is what puts the block's own box back at the origin after a flip, so
a placed instance covers `[x, x+S] × [y, y+S]` whatever its orientation.

**Being restricted to these eight is the reason block instancing cost almost
nothing to add.** It is not a property the design happens to have; it is the
property the design is built on, and it is worth being explicit about what it
buys, because anyone extending this to arbitrary transforms is giving all of it
up at once:

| because every matrix entry is 0 or ±1 with whole-nanometre offsets | which means |
|---|---|
| a rect maps to a rect | the viewport transformed into an instance's block space is still an axis-aligned rectangle, so tile culling runs **unchanged** inside the block — no clipping against rotated bounds, no conservative over-fetch |
| the inverse is exact | `toBlock(toChip(p)) == p` bit-for-bit, so the viewer can invert per frame with no epsilon and no drift. `tools/verify.js` checks it on every instance, at the block corners and at an interior point |
| geometry stays Manhattan | the whole renderer's one invariant survives the transform: everything on screen is still an axis-aligned rectangle, so the quad path, the subpixel test and the depth key all work untouched |
| the transform is exact in integers | tile origins stay whole nanometres, so the f64-on-the-CPU / f32-in-the-shader split that keeps precision at chip scale is unaffected |

A general affine placement — arbitrary rotation, or scaling — breaks every row
of that table at once: culling would need rotated bounds and would over-fetch,
the inverse would carry rounding, rectangles would arrive at the rasteriser as
rotated quads, and a scaled instance would want a different LOD level from its
neighbours. Chip assembly does not need any of it — LEF/DEF orientations are
exactly these eight — which is why the format does not offer it.

### Fetched once, drawn N times

Tile keys are `(z, x, y)` *inside the block*, so instances share every byte
without the store knowing they exist: one entry in the cache, one request in the
queue, one line in the eviction list. Nothing in `src/tiles.js` mentions chips.

The renderer draws the resident set once per visible instance. The slot buffers
are untouched between instances — an instance is two uniforms:

- `u_tileBase`, its window into the per-tile origin table, which is indexed
  `(instance, slot)` rather than `(slot)`. Each entry is that tile's origin
  already transformed into chip space and made relative to the view origin, so
  the f64 work stays on the CPU exactly as it did with one block.
- `u_rot`, the 2×2 above, applied to tile-local coordinates in the vertex
  shader.

An entry also carries a validity flag: a tile that is resident because a
*neighbouring* instance wants it collapses its vertices rather than drawing off
screen.

Measured at the full-chip view, 70 instances of a 5M-placement block:

| | |
|---|---|
| tiles fetched | **1** |
| tile draws | 70 |
| draw calls | 70 (one per instance; the level is far, one call each) |
| rectangles on screen | 73,500 = 1,050 × 70 |
| GPU slot memory | 5.25 MB — one block's worth |
| staging cost of a visible-set change | below the 0.01 ms timer |

and one level down, where six blocks are on screen at `z2`: 16 tiles fetched, 50
tile draws. Inside a single block nothing changes at all — 1 instance, 8 draw
calls, exactly the numbers from before the chip existed.

### Where it costs

- **Draw calls scale with visible instances**, not with tiles: 70 at the chip
  view, 8 (one per rect-count bucket) inside a block. That is the ladder's doing
  — it refuses a level whose tile draws across all visible instances exceed the
  rail, which is what keeps the chip view on one merged tile per block.
- **Orientation is free relative to translate-only**, in the sense that matters:
  the transform is applied unconditionally, so a chip of all-N instances runs
  the same code as one cycling all eight. What it costs *at all* is 2 multiplies
  and 2 adds per vertex, one `vec4` uniform per draw call, and one integer per
  instance in the manifest. Rendering the same chip translate-only, mirrored by
  rows, and cycling all eight orientations produced identical timings — all
  below this setup's measurement resolution.
- **The origin table is a rail.** It holds 4,096 `(instance, tile)` entries;
  past that the furthest instances are dropped rather than the table corrupted.
  The ladder's budget refuses those zooms long before, so the rail is a
  backstop, not a policy.

### Not implemented: more than one distinct block

The format lists `blocks[]` and every instance names one, but the viewer loads a
single master library and a single pyramid, and ignores instances of any other
block (it says so in the HUD). A real multi-block chip needs one master texture
and one slot-pool set per block, which is bookkeeping rather than a new idea.
The 89 GB case that motivated this is one block, 70 times.

---

## Choosing a level at runtime

The generator decides what each level *is*. The viewer decides which one to
draw, and it decides on the same two numbers — the rectangle budget and how many
pixels a cell covers — so what reaches the screen is what the level was built
for. The rule lives in `src/lod.js`, which the generator imports rather than
reimplements; `[` and `]` still force a level by hand for debugging, and `l`
returns to automatic.

**One ladder covers both levels of hierarchy.** A level's cost on screen is
summed over the block instances the viewport touches, so the same rule that
picks a level inside one block also picks the chip view: zoomed out far enough
that dozens of blocks are visible, only the coarsest level of each block fits,
and one merged tile per block *is* the chip view. There is no separate chip
ladder and no chip-level pyramid.

### The ladder

Every level gets one **switch-out scale**: the lowest camera scale, in device
pixels per nanometre, at which it is allowed on screen. Three constraints,
whichever binds hardest, then forced monotone in `z`:

| binds | the level is refused below the scale where … |
|---|---|
| `budget` | its tiles across every visible instance, plus their overflow lists, fit `rectBudget` |
| `cells` | a mean cell spans `minCellPx` — placement levels only |
| `tiles` | at most `maxVisibleTiles` tile draws are on screen |

With a viewport of `resW × resH` device pixels at scale `s`, covering
`vw × vh` nanometres:

```
instances(s) = min(nx, vw/pitchX + 1) · min(ny, vh/pitchY + 1)
perInstance  = min(tilesPerSide, min(vw, blockW)/tileSize + 1)
               · min(tilesPerSide, min(vh, blockH)/tileSize + 1)
tiles(z, s)  = instances(s) · perInstance
rects(z, s)  = tiles(z, s) · rectP95PerTile(z) + instances(s) · overflow.rectCount
```

Every cap in there earns its place. A viewport wider than the block pitch
touches more instances, but never more than exist. A viewport wider than one
block cannot see more of that block than the block has tiles — without that cap
the ladder believes a single block can fill a screen with 128 tiles at every
level, and every coarse level looks necessary when it is not. And the `+1` per
axis is the partial tile hanging off each edge: not a rounding detail, it is why
at equal zoom a coarse level draws **more** off-screen geometry than a fine one,
and so why the ladder has to be forced monotone at all.

Those caps also killed the closed form. `tiles(z, s)` is monotone in `s`, so each
constraint is inverted by bisection with a fixed iteration count, which keeps the
generator and the viewer bit-identical; `tools/verify.js` checks that the ladder
the viewer derives reproduces the shipped one exactly.

The `cells` bound is what keeps mid geometry off a full-die view. It is a
property of the zoom alone, not of the level: a mean cell is `meanCellWidth · s`
pixels wide wherever it is drawn from, and below `MIN_CELL_PX` an outline is the
noise the spike found, while density blocks still carry the floorplan.

### The floor, and where it actually stops

The coarsest level takes `minScale = 0`, bound `floor`: something must always
draw, so the level of last resort has no lower end of its own. That leaves the
question of where the lower end really is, and the answer is not in the ladder at
all — it is the camera. Zooming out is clamped at fit-to-die (`MIN_ZOOM_FILL` of
the viewport, in `src/camera.js`), because there is nothing outside the die to
navigate to and every map application stops at whole-world.

Without that clamp the floor level applies however far out the camera goes, and
a far level has no `cells` bound to stop it: at 1.17e-5 px/nm a z0 density block
is 0.9 pixels across and the density map is noise, where at 3.34e-5 it is 2.6
pixels and reads correctly. So each ladder entry also carries `contentScale` —
the scale at which that level's own smallest feature spans `MIN_CELL_PX`, a mean
cell for the placement levels and a density block (`tileSize / blockGrid`) for
the far ones — and the floor entry carries `floorSlack`, its `contentScale`
divided by the lowest scale the camera can reach. Above 1 the floor level is
reachable below what its content was built for, and the HUD's ladder line says
so rather than leaving it as an unwritten edge case.

`contentScale` is reported, never selected on: feeding it into `minScale` for the
far levels would move switch points that the pyramid on disk was already written
against.

## placements.bin

The index deep and mid tiles are produced from when a design is generated with
`--lazy`. Every level that carries placements holds each placement exactly once
at 12 bytes, so each such level is one full copy of the placement array; the
pyramid writes two of them, and on the 50M design that is 1,144 MB of the 1,182
MB total. This is one copy at 4 bytes, and it serves every level.

Nothing in the tile format changes. A tile produced from this index is
byte-identical to one full generation writes — that is checked by the generator
on a sample before it finishes, and by `tools/verify.js` on every tile.

### Header, 64 bytes

| offset | type | field | |
|---|---|---|---|
| 0 | u32 | `magic` | `MTNP` |
| 4 | u16 | `version` | same version as the tiles |
| 6 | u16 | `recordBytes` | 4, 5, 6 packed, or 12 unpacked |
| 8 | u32 | `count` | placements |
| 12 | u32 | `tilesPerSide` | at the deepest level, `2^maxZ` |
| 16 | i32 | `tileSize` | deepest tile, nm |
| 20 | i32 | `gridX` | coordinate quantum, nm; 1 if off-grid |
| 24 | i32 | `gridY` | |
| 28 | u8 | `bitsX` | field widths in the packed record |
| 29 | u8 | `bitsY` | |
| 30 | u8 | `bitsM` | |
| 31 | u8 | `packed` | 0 = records are the 12-byte tile record verbatim |
| 32 | u32 | `countsOff` | always 64 |
| 36 | u32 | `dataOff` | `64 + tilesPerSide² · 4` |

Then `tilesPerSide²` u32 counts, row-major, one per deepest tile. Counts, not
offsets: an offset into an eleven-billion-placement index does not fit a u32
while a count per tile never comes close, and the prefix sum is rebuilt at open
in f64, which is exact to 2^53.

### Records

Grouped by deepest tile in the order `bucketDeepest` produces — tile-major,
ascending original index within a tile. That order is part of the tile bytes, so
it is part of this format's contract, not an implementation detail.

A tile at level `z` covers a `2^(maxZ-z)` square of deepest tiles, which is one
contiguous range here per row of that square, concatenated in the same row-major
order `collectTile` walks them in. At the deepest level that is a single range.

Packed, the record is one little-endian integer with `dx` in the low `bitsX`
bits, then `dy`, then the master id, then 3 bits of orientation:

```
dx = x / gridX - floor(tileOriginX / gridX)
dy = y / gridY - floor(tileOriginY / gridY)
```

The difference of two quantised values, **not** the quantised difference. A tile
size need not be a multiple of the row height — 38.8um tiles on 1um rows are not
— so `(y - tileOrigin)` can be off-grid even when every `y` is on it. Getting
this wrong is silent: the tiles still verify, still have consistent content
boxes, and are simply in the wrong place by less than one tile origin's
remainder. The field is one step wider than the tile to hold the difference, and
every record is range-checked as it is written.

`gridX` and `gridY` are measured from the placement list, not assumed: if any
coordinate is off-grid the quantum drops to 1nm and the fields widen. If the
whole record will not fit 48 bits, `packed` is 0 and the records are the tile's
own 12-byte placement record.

On both the 5M and 50M designs the result is 30 and 31 bits respectively — one
4-byte word, a third of the 12 the tile record needs.

### Levels that no zoom can select are not written

After the monotone pass a level can end up sharing its switch-out scale with the
next finer one, which then takes over the instant either becomes legal: the
coarser level's window is empty. That is the normal outcome for the
second-deepest level, because a finer level of the same kind is genuinely
cheaper to draw at equal zoom. The generator solves the ladder **before** it
writes anything — per-tile rectangle costs come from the placement list, not
from tiles on disk — and skips those levels entirely. On the 5M design that is
z5, 57.1 MB of 174.4 MB, written for nothing. `manifest.lod.shadowed` lists what
was skipped and `tools/verify.js` checks the tiles really are absent.

Dropping one level lowers the monotone floor for every finer level, which can
empty another window, so the pass iterates to a fixpoint. The pyramid it leaves
has gaps: `z` is not a dense range, and the viewer steps between the levels that
exist.

#### The tile set is not a pure function of the block

This is the part to write down. Which levels get written depends on **the chip
the block is instanced into**, because a level's cost on screen is summed over
the instances the viewport touches. A block's coarse far levels exist to serve
the chip view, where dozens of blocks are on screen at once; seen alone, a block
never needs a far mip below its own finest, and the ladder says so:

| generated with | levels written |
|---|---|
| `--blocks 70` | z0 z1 z2 z3 z4 z6 |
| `--blocks 1` | z3 z4 z6 — z0, z1 and z2 have empty windows |

Identical block data, different pyramid. `manifest.lod.solvedFor` records the
instance geometry the ladder was solved for, so what a set of tiles assumes is
at least legible after the fact.

The consequence is operational, not theoretical: **changing the chip assembly
can force a retile even though no block data changed.** Placing the block 70
times instead of once, or spacing the instances differently, moves the switch
points and can make a skipped level necessary again. At a block of tens of
gigabytes that is hours of work triggered by an edit to a manifest, so it is
worth deciding deliberately rather than discovering.

Two ways out, neither taken here because both cost something real:

- **Write every planned level regardless.** The pyramid is then a pure function
  of the block, at the price of the disk this section exists to save — 33% on
  the 5M design.
- **Solve the ladder for the widest chip the block might land in** (say, 4096
  instances) and write for that. Levels stop depending on the assembly, and the
  cost is a few coarse levels that a small chip will never select — cheap, since
  coarse levels are the small ones. This is the better trade if retiling is
  expensive, and it is a one-line change to what `viewOf` is handed.

One consequence worth knowing: a shadowed level is also the natural *parent* for
parent-while-loading (see Known constraints). Dropping z5 means the parent of
the deepest level is the mid level, which is a coarser fallback but a legitimate
one.

### Hysteresis

A bare threshold makes the level flicker whenever the camera parks on it. Each
level's **switch-in** scale is `hysteresis` times its switch-out scale, and the
whole band sits at or above the scale the level was cleared for:

```
switch in to z   when   s >= minScale(z) · hysteresis
hold z           while  s >= minScale(z)
otherwise               the finest level whose switch-in scale is met
```

Stickiness is therefore only ever spent staying coarse — a level is never drawn
below the zoom its budget was proved at, only above the zoom that would have
promoted it. One wheel notch is `exp(0.0015 · 100)` = 1.16×, so `hysteresis`
must exceed that or a single notch could round-trip; 1.3 leaves about a notch of
dead zone. The first pick after load ignores the band: nothing is on screen yet
to flicker, and opening one level coarser than the zoom justifies would leave it
there until the camera moved.

### Switch points are data, not constants

They follow from the design — tile sizes, and the p95 rectangle cost of a tile
at each level — from the chip, since a level's cost is summed over visible
instances, and from the window, since rectangles on screen scale with viewport
area. A 3440×1440 canvas at `dpr` 2 costs 5.6× a 1920×1080 one at the same zoom,
which is more than the whole gap between two levels.

So the manifest ships the inputs, `manifest.lod.switchPoints` ships the ladder
solved at a reference viewport for the chip the generator emitted, and
`manifest.lod.solvedFor` records the instance geometry that was — while the
viewer re-solves against its real canvas and its real `chip.json` at boot and on
every resize. The same block viewed alone and viewed as 70 instances gets two
different ladders from the same files, which is the point: seen alone, a block
never needs a far mip below its own finest one, and `z1` and `z2` collapse to
zero.

### Measured

`?sweep=1` walks the zoom range through the real selector in both directions,
records where the level actually changes, then parks the camera at each of those
scales and reads the rectangle count the renderer is holding. 4,990,711
placements, 70 block instances, 3424×1345 canvas, worst of five camera
positions:

| switch | at px/nm | cell px | before | after |
|---|---|---|---|---|
| in, z0→z1 | 2.443e-4 | 0.17 | far, 29,400 rects over 28 blocks, 28 draws / **1 fetched** | far, 110,068 over 28, 72 draws / 4 fetched |
| in, z1→z2 | 6.333e-4 | 0.45 | far, 23,586 over 6, 15 draws / 4 fetched | far, 89,988 over 6, 50 draws / 16 fetched |
| in, z2→z3 | 1.457e-3 | 1.04 | far, 21,610 over 2, 15 draws / 12 fetched | far, 54,498 over 2, 36 draws / 32 fetched |
| in, z3→z4 | 3.350e-3 | 2.39 | far, 9,218 over 1, 10 draws | **mid, 683,130**, 32 draws |
| in, z4→z6 | 8.222e-3 | 5.87 | mid, 195,960, 8 draws | **deep, 816,423**, 60 draws |
| out, z6→z4 | 6.316e-3 | 4.51 | **deep, 1,531,094**, 112 draws | mid, 367,013, 15 draws |
| out, z4→z3 | 2.574e-3 | 1.84 | **mid, 997,429**, 50 draws | far, 12,879, 15 draws |
| out, z3→z2 | 1.113e-3 | 0.80 | far, 85,692 over 6, 40 draws / 16 fetched | far, 21,834 over 6, 12 draws / 4 fetched |
| out, z2→z1 | 4.865e-4 | 0.35 | far, 119,984 over 8, 60 draws / 16 fetched | far, 31,448 over 8, 21 draws / 4 fetched |
| out, z1→z0 | 1.867e-4 | 0.13 | far, 141,516 over 36, 96 draws / **4 fetched** | far, 37,800 over 36, 36 draws / **1 fetched** |

The worst on-screen count anywhere in the range is **1,531,094 rectangles of the
2,000,000 budget (77%)**, at the deepest level just before it is given up. The
five chip-level switches at the top of the range are the same rule doing the
same job one level of hierarchy up — and the fetch column is the instancing
payoff in one number: 96 tile draws from 4 fetched tiles, 36 from 1.

The `cells` bound lands where it was aimed: 1.84 px per cell leaving mid on the
way out, 2.39 px arriving on the way in, the gap being the 1.3× band.

Two things the sweep shows that the ladder alone does not:

- **z5 is never selected, so it is never written.** It shares z6's switch-out
  scale, because z6's finer tiles waste less area off the viewport edges.
- **The estimate runs high at coarse levels** (est 134k against 22k measured at
  z2 zooming out). It assumes a full screen of tiles per instance and every
  instance fully in view; reality is partial blocks at the screen edge. That is
  the conservative direction for a budget.

---

## Identity, and what the format cannot answer

Clicking a placement resolves through the same transform and the same tile
arithmetic the culling path uses - chip point to block point through the
instance transform, block point to tile, then a scan of the tile. No index is
built: a tile *is* a spatial index, it holds a few thousand placements, and a
parallel structure would have to be maintained per level and kept in step with
eviction to answer nothing new. The scan widens by two things that are cheap to
include: neighbouring tiles within the level's content bleed, and the level's
overflow list, which is where the macros are.

What comes back is everything the format carries about a placement:

| answered | from |
|---|---|
| master index, class, width, height | `masters.bin`, via the placement's master id |
| orientation | the placement record's packed word |
| position, in block and in chip nanometres | the record, and the instance transform |
| which block instance, and where it sits | `chip.json` |
| which tile, and which placement within it | the tile the scan found it in |

**There are no names.** A placement is `(x, y, master | orient << 16)` and a
master record is `(rectStart, rectCount, w, h, klass, rowH)` - twelve bytes and
thirty-two bytes with nowhere for a string in either. So the viewer reports a
master as `#1149` and says so in the panel rather than inventing `DFFQX1_A`,
and there is no search box, because searching for names the format does not
carry would be a feature that only works on synthetic data.

Identity in practice is position: two cells cannot occupy the same origin, so
`(block instance, x, y)` names a placement exactly, and that is what a shared
link carries.

### What a click is allowed to land on

More than one thing can be under a point — a cell inside a macro's footprint, a
cell under a power strap — and the scan used to break the tie by taking the
smallest hit, on the grounds that the more specific answer is the one someone
wants. It usually is. It is also a guess, and it is the wrong one whenever the
thing you are trying to reach is the large one.

So the tie has a control in front of it: the layer panel's **S** column is a
mask, `pick()` drops every candidate whose category bit is clear, and the
smallest-hit rule runs on what is left. Turning S off for macros makes a click
inside a macro's footprint report the cell underneath it, which is the case the
column exists for.

The mask is read at the **category** bit — `CLASS_LAYER[klass]`, one of
cellbox, macrobox, powerbox — whatever level is on screen, because that is what
a click resolves to at every level. A deep tile's process layers are not part of
this: a click identifies a placement, never one of its rectangles, so there is
no such thing as picking metal2.

When the mask excludes everything under the point, the readout says so and how
many were skipped. A filter that turns a hit into silence otherwise looks
exactly like a viewer that has stopped working.

### What names would cost

Worth writing down, because the answer is not symmetric:

- **Master names are nearly free.** A `names.bin` of concatenated UTF-8 with a
  `u32` offset per master is about 60 KB for a 4,634-master library, fetched
  once beside `masters.bin` and resident forever. This is the one to do first:
  it turns `#1149` into a cell type, which is most of what a person wants.
- **Instance names are the expensive one.** A name per placement means either a
  `u32` offset in every placement record - 12 bytes to 16, **+33% on every deep
  and mid tile**, on the format's largest files - or a side file per tile that
  the viewer fetches only when something is clicked. The side file is the better
  trade: identification is interactive and rare, streaming is not.

Neither is implemented, and the second should not be until a real DEF says how
long the names are.

---

## Layers

A layout is a stack, and drawn flat and opaque the upper layers hide what is
underneath. Almost every question worth asking is layer-scoped — is metal3
congested here, does poly cross diffusion at this point — so the layer controls
are not decoration, they are how the view gets asked a question.

All of it is uniforms. Nothing below rebuilds a buffer, re-uploads a slot or
re-fetches a tile; the geometry on the GPU is the same geometry whatever is
being shown.

| control | key | mechanism |
|---|---|---|
| visibility | `1`-`9` `0` | `u_layerMask`, one bit per layer id. A hidden layer's vertices collapse to a degenerate position in the vertex shader, so it costs no rasterisation |
| selectability | — | not a uniform: the mask `pick()` filters candidates by, before the smallest-hit tiebreak. See "Identity, and what the format cannot answer" |
| solo | `shift`+`1`-`9` | the mask, set to one bit plus the whole of the other half (below). Repeating it restores the mask that was in force before, not "everything" |
| all on / off | `a` | the mask, set to `0xffff` or `0` |
| per-layer alpha | `v`, or the panel's C column | `u_layerAlpha[16]`, and the ordered per-layer pass described under "Rendering is opaque-only". Whether the translucent path runs at all is read off the array, not tracked beside it |
| colour by layer / class | `c` | `u_colorMode`; the palette index is a varying, separate from the depth key |

Hiding a layer in the vertex shader rather than discarding fragments is
deliberate: a discarded fragment has already cost a rasterised pixel, while a
collapsed vertex costs nothing downstream at all. The visible result is the
same.

### The mask is two halves, and a level carries one of them

The 16 layer ids are not one space. Ids **0-11 are process layers** and appear
only in deep tiles; ids **12-14 are the instance categories** — cellbox,
macrobox, powerbox — and appear only in mid and far tiles. `PROCESS_MASK` and
`CATEGORY_MASK` in `src/format.js` name the two, and the renderer's
`effectiveMask` is the user's mask with the half the level does not carry forced
on:

```
effectiveMask = layerMask | deadMask     // deadMask is CATEGORY at deep, PROCESS above it
```

Forcing rather than obeying is the point. "Show me metal1" has no referent at a
far level and "show me macros" has none at a deep one, and a filter that is
obeyed into an empty frame is a layer key that blanks the screen and calls
itself a filter. `layerFilterIgnored` puts which half is being ignored on
screen, and the layer panel dims the rows it applies to.

The whole mask used to be discarded above the deep levels, on the grounds that
those levels have "no layer identity". They do — three ids of it — and the
consequence was that macros and the power grid could not be filtered at any
zoom, which is exactly what someone at the chip view wants to do first. Splitting
the mask is what makes the panel's instance rows real controls.

A **solo** stays inside its own half for the same reason: soloing metal2 says
nothing about whether macros should be drawn at a far level, and reading it as
"hide those too" would blank every level with no metal2 to show.

### The layer panel

`src/panel.js` is the row model and `#layers` in `src/index.html` is its styling;
between them there is no framework and no dependency. A row is one layer id, so
a row is one palette entry, one mask bit and one colour chip. Groups carry a
parent toggle, which is a convenience at three metals and the only usable form
at the ten a real stack has.

Three columns, V, S and C. V and S are the two axes the reference panel
(RedHawk-SC) separates and this viewer did not; C is the layer's colour, and
clicking it is the per-layer half of an alpha control that until then could only
be set for every layer at once. Their panel has a fourth column, M, whose
meaning is not known here — when it is, it is one more entry in `COLUMNS` and
one more branch in `_get`/`_set`.

**S has a referent only where a click can resolve to it.** A click resolves to a
placement or to a density block, and what either of those *is* — a cell, a
macro, the power grid — is an instance category, never a mask. So the column is
live on the three instance rows and inert on the twelve process rows, at every
level, rather than being a control that silently does nothing.

### Colour by class

The classes are the ones the format carries in `masters.bin`: **standard cell**,
**macro**, **power**, and **filler/decap**. Filler is a class rather than a flag
because it is the difference between area that is occupied and area that is
doing something, which is the same distinction the far levels' second density
channel exists for.

Combinational versus sequential is **not** in the data model. It is the split an
engineer would want next — where the flops are — and it does not fit for a
concrete reason worth recording: colouring by class indexes a palette that also
serves the 16 layer ids, and the depth key is `1 - layer/16`, so the layer id
space is full at 16. Adding a class costs a palette slot, which exists, but
adding a *layer* would cost a re-cut of the depth key.

---

## Streaming and eviction

The viewer never blocks a frame on the network. `refresh()` tells the store
everything the camera justifies, in priority order, and immediately draws
whatever has already arrived; tiles fold in as they land.

- **Priority.** The visible set is served nearest-to-viewport-centre first, then
  a ring of neighbouring tiles at lower priority. The ring is what gives the
  cache something worth holding.
- **Supersession.** When the camera moves, requests still queued for tiles it no
  longer wants are dropped, and requests already in flight are aborted. Measured
  over 12 rapid jumps at the deepest level: 40 dropped, 55 aborted, 13 actually
  fetched — without it all 108 would have been.
- **Eviction.** LRU by last use against a byte budget, with the resident set
  pinned. Same traversal at the deepest level, 47 tiles loaded: 9 evicted at a
  1 MB budget, 0 at 64 MB. The budget can be exceeded if the visible set alone
  is larger than it; that is reported in the HUD rather than enforced, because
  dropping a visible tile only makes the viewer refetch it immediately.

Coverage bitmaps mean a tile is never requested unless it exists, so empty
regions of the die cost nothing.

## Known gaps

Everything above describes what the format does. This is what it does not,
collected in one place because it was previously spread across commit messages
and whichever section happened to touch it. Ordered by how much each one
matters, which is not the order of how much work each one is.

### Deep zoom shows cell internals that a real LEF does not have

**This is the assumption in the project most likely to be wrong.** The deep
representation draws ~11 rectangles per placement - diffusion strips, poly
gates, contacts, local metal1, pins - because that is what `tools/layout.js`
invents for a standard cell, and the deep level exists to have something worth
drawing at the bottom of the zoom range.

A real `cells.lef` does not contain that. It gives a cell's bounding box, its
**pin shapes**, and its **obstructions** - the regions routing must avoid. The
transistor-level internals live in the foundry's GDS, which is not what a layout
viewer is pointed at. So the deepest level may be drawing a thing with no
counterpart in the input.

What would move if that holds:

- the rects-per-placement figure the deep level is budgeted against. Pins plus
  obstructions is plausibly fewer than 11, which would shift every switch point
  and might make another level deep;
- the rect-count histogram, and with it the derived bucket caps and the padding
  figure. The caps are solved from the design's own histogram precisely so this
  is a re-solve rather than a redesign - but the shipped numbers would change;
- what "deep" means as a representation. It may be closer to "pins and
  obstructions" than to "internals", which is a different picture on screen even
  though it is the same byte layout.

None of the format changes. The placement record, the bucket table and the
master rect list carry pins and obstructions exactly as well as they carry
invented internals. What is untested is whether the *shape* of real geometry
lands where the budget was aimed - and nothing here can be settled without a
real LEF. Inventing an answer would be fitting to the generator again.

### No names, so no search

A placement is `(x, y, master | orient << 16)` and a master record is
`(rectStart, rectCount, w, h, klass, rowH)` - twelve bytes and thirty-two bytes
with nowhere for a string in either. So the viewer reports a master as `#1149`
rather than inventing `DFFQX1_A`, and there is no search box: searching for
names the format does not carry would be a feature that only works on synthetic
data.

The cost is not symmetric. Written up in full under "Identity, and what the
format cannot answer":

| | |
|---|---|
| master names | a `names.bin` of concatenated UTF-8 with a `u32` offset per master - **~60 KB** for 4,634 masters, fetched once beside `masters.bin` and resident forever |
| instance names, in the record | a `u32` offset per placement: 12 bytes to 16, **+33% on every deep and mid tile**, on the format's largest files |
| instance names, as a side file per tile | one extra request, and only when something is clicked |

The side file is the better trade - identification is interactive and rare,
streaming is not - and it is **deferred until a real DEF says how long the names
are**. Sizing a per-tile side file against invented name lengths would settle the
trade on made-up numbers.

Identity in practice is position: two cells cannot occupy the same origin, so
`(block instance, x, y)` names a placement exactly, and that is what a shared
link carries.

### One undifferentiated power layer, and no named nets

The same gap as search, one level up, and it is listed separately because the
decision it is waiting on has to cover both at once.

The format carries **one** power layer at deep zoom (`L.PWR`, id 11) and **one**
power category above it (`powerbox`, id 14). Every strap in the design draws on
them. A real design has power *domains*: RedHawk-SC's layer panel lists `VDD`,
`VSS`, and then a long tail of named rails — `PCIE_UTIL_VPH_X4_1`,
`PCIE_UTIL_VP_X1_0`, and so on — each individually visible or hidden, because
which rail a strap belongs to is the question being asked. Power domains are
first-class entities there and they are one undifferentiated layer here.

The block is naming, exactly as it is for search. A strap is a placement, a
placement is `(x, y, master | orient << 16)`, and there is nowhere in it for
`VDD` any more than there is for `DFFQX1_A`. Splitting the layer id would not
help and could not: the id space is full at 16 (see "Colour by class"), and a
design with forty rails needs forty names, not forty layers.

So when the naming decision is taken it has to name **three** things, not two:

| | |
|---|---|
| masters | a cell type — `~60 KB` for 4,634, resident forever |
| instances | a placement's own name — the expensive one, per-tile side file |
| **nets** | which rail a strap belongs to. Small — a design has tens of power nets, not millions — but it needs a `u16` net id on the placement record or a per-tile side list, and that is the same format decision the other two make |

Deciding instance names first and nets later would settle the record layout
without the case that most wants a field in it. **Blocked on reading a real
LEF/DEF**, with the rest of naming; see the roadmap.

### The layer stack is three metals wide, and cannot widen without a re-cut

`tools/layout.js` emits twelve process layers, of which three are metal and two
are via. A real stack is ten and ten, and RedHawk-SC's panel lists `M0` through
`M9` beside `VIA0` through `VIA9`.

Nothing in the *viewer* cares. The layer panel is built from a table of rows and
groups, the palette is indexed by layer id, and the parent toggles exist
precisely because ten metals is where a flat list stops being usable. Widening
the generator is a bigger master library and more `pushRect` calls.

What stops it is the **layer id space, which is full at 16**, and the depth key
`1 - layer/16` cut against it. Ten metals plus ten vias plus device, pin, macro
and outline is past 16 before the three instance categories are counted at all.
Widening means re-cutting the depth key to more bits — mechanical, and it
touches the vertex shader, the palette, the mask, and the two half-masks the
panel is built on. Worth doing against a real stack, not against a guess at one.

### Colour by class is cell/macro/power/filler, not combinational/sequential

The classes `masters.bin` carries are **standard cell**, **macro**, **power** and
**filler/decap**. The split an engineer would reach for next is combinational
versus sequential - where the flops are - and it is not in the data model.

The block is structural rather than an oversight. Colouring by class indexes a
palette that also serves the 16 layer ids, and the depth key is `1 - layer/16`.
Adding a *class* costs a palette slot, which exists. Adding a *layer* would cost
a re-cut of the depth key, and **the layer id space is full at 16**. See "Colour
by class".

### The filler channel is nearly flat, so contrast comes from logic alone

A far tile carries two density channels, logic and filler, because area that is
occupied and area that is doing something are different questions. On this
generator the second one barely moves: filler is drawn from the same global
usage distribution as logic, so it is spread evenly at ~30% of placements. A
real design fills whatever the placer left, so filler concentrates exactly where
utilisation is low.

So on synthetic data **the regional signal is entirely in the logic channel**,
and sparse regions read blue. The dead-area grey mix is implemented and correct;
there is nothing here for it to bite on.

The faithful model - fill the leftover row space - was written, measured and
reverted. It resizes the die, because occupancy stops being the density mean;
that moves every switch point; that changes which levels are worth writing. It
is a placement-model decision worth taking deliberately rather than as a side
effect of a rendering change. See "What the viewer does with it".

---

## Known constraints

### Rendering is opaque-only

Using the layer id as a depth key gives painter's ordering for free — metal over
poly over diffusion with no draw-call sorting — and that freedom is exactly what
allows batching by bucket, since a bucket mixes every layer together. It buys
that at a price: **it only works for opaque geometry.**

Chip viewers generally want translucent layers, so poly is visible under metal1
under metal2. Blending with depth writes enabled produces order-dependent, wrong
results: whichever fragment lands first wins the depth test and later fragments
behind it are discarded rather than blended, so the composite depends on
submission order.

Supporting translucency needs depth writes off and explicit back-to-front
ordering per layer — that is, drawing layer by layer, which conflicts with
grouping draws by rect-count bucket, because a bucket contains masters whose
rects span every layer.

**That pass is now implemented**, and it is what per-layer alpha uses:
`layers × buckets × instances` draw calls with the layer mask narrowed to one
layer per pass, depth writes off, blending on. Inside one block that is 12 × 8 =
96 calls, measured. It is off by default because the opaque path is one pass and
correct, and it is on the moment any layer's alpha drops below 1.

Two things it does not fix. Overlapping geometry *within* one layer blends with
itself rather than being resolved by depth — in this data cells do not overlap
their own layers, so it does not arise, but it is not a guarantee the renderer
makes. And the cost scales with visible layers, so it is a deep-zoom tool: at
chip zoom the same switch would multiply 70 instance draws by every abstract
layer.

Layer *visibility* is cheaper and unconditional: `u_layerMask` is a 16-bit
uniform, hidden layers collapse their vertices in the vertex shader, and nothing
is rasterised for them. **Hiding a layer never touches a buffer** — see Layers.

### Draw calls are bounded by bucket count, not library size

This was the version 2 failure. Grouping by master bounds draw calls by the
number of *distinct masters in the visible set*, and that union saturates the
library from a couple of dozen tiles onward - so the draw count simply *is* the
library size:

| visible set | library | distinct masters touched |
|---|---|---|
| 16 deep tiles | 400 | 393 |
| 72 deep tiles | 400 | 396 |
| 25 deep tiles | 4,634 | 3,619 |
| 26 deep tiles | 4,634 | 4,000 |
| 49 deep tiles | 4,634 | 4,395 |

400 masters cost ~400 draws, which fits. 4,634 masters cost ~4,400, which does
not. Since the count is a property of the library and not of the camera, no
amount of culling helps.

Version 3 groups by rect-count bucket instead: **4 draw calls, independent of
library size**, measured at 4,634 masters. Mid and far are one draw call each.
The cost is bucket padding, quantified above.

### Slots are persistent, so a pan does not rebuild anything

Version 2 kept one staging buffer sorted by master and rebuilt it whenever the
visible set changed - which happens every time the camera crosses a tile
boundary. That was 8.8 ms median for 500k placements and would have been ~36 ms
at the full mid budget: a multi-frame stall on every crossing.

The record the vertex shader reads is now origin-independent - tile-local
coordinates, master id, orientation, and a *tile index*:

| off | type | field |
|---|---|---|
| 0 | i32 | `x` tile-local nm |
| 4 | i32 | `y` tile-local nm |
| 8 | i32 | `masterId` in low 16 bits, `orient` in bits 16-23; -1 marks a released slot |
| 12 | i32 | tile index into the origin table |

Nothing in it depends on the camera, so it is written once when a tile loads and
never rewritten. The view origin lives in a small per-tile table (an RGBA32F
texture, one texel per resident tile) holding `tileOrigin - viewOrigin` computed
in f64 on the CPU. Panning changes one uniform. A precision resnap rewrites a
few kilobytes of that table. Neither touches a slot buffer.

Each bucket owns a persistent buffer with a free list. A tile entering claims a
contiguous run per bucket; a tile leaving has its run overwritten with the -1
sentinel and returned to the list, coalescing with neighbours. Draws cover
`[0, highWater)` in one call, so released slots cost a discarded vertex rather
than a wrong pixel.

Measured cost of one visible-set change while panning:

| design | level | tiles resident | placements | tiles added | worst update |
|---|---|---|---|---|---|
| 500k | z4 deep | 19 | 32,034 | 4 | 0.90 ms |
| 500k | z3 mid | 7 | 42,415 | 2 | 1.60 ms |
| 5M | z6 deep | 40 | 60,179 | 6 | 1.20 ms |
| 5M | z5 mid | 43 | 220,711 | 6 | 2.60 ms |

Against a 4 ms target. Note these are headless software-rasteriser numbers: the
CPU half of the work measures ~4 ns per placement (`tools/bench.js`, no renderer
competing), so ~0.5 ms for a six-tile crossing, and the rest is `bufferSubData`
through a software driver. On real hardware it should be lower, but that is
unmeasured here - the HUD reports `update last / worst ms` live, so the true
number is one glance away on a real GPU.

### Two levels in one frame: a scheduling gap, not a blocked feature

Cross-fading between LOD levels, and keeping a parent level on screen while its
children stream in, both need two levels drawn in the same frame. Neither is
implemented. Neither is blocked by the depth key.

**Residency is single-kind.** `renderer.kind` is global and `setVisible` drops
every slot when it changes. The slot pools themselves are per *kind* (deep, mid,
far), not per level, so two levels of the same kind could already coexist — the
blocker is bookkeeping, not structure. Tiles are keyed `(z, x, y)` and eviction
pins by that key, so nothing in the cache or the eviction logic assumes one
level. This is a scheduling change, and it is the whole of what is missing.

**Parent-while-loading needs no alpha at all.** Draw the parent level, clear the
depth buffer, draw the child level over it. Children paint where they have
geometry and the parent shows through the gaps.

**Cross-fade needs no blending within a level either.** Two opaque passes,
composited:

- render level N into an offscreen framebuffer — opaque, depth on, exactly as
  the renderer draws today
- render level N+1 into a second framebuffer the same way
- composite the two with one full-screen quad and one alpha uniform

Each pass owns its depth buffer, so layer ordering inside each level is
untouched and the depth key keeps doing exactly what it does now. The cost is
one extra pass and two colour+depth targets at canvas resolution, paid only for
the ~200 ms a transition lasts.

What the depth key does rule out is **translucent layers** — poly visible under
metal1 under metal2 — because that needs fragments *within one pass* to blend,
and the depth test discards exactly what blending would need. See "Rendering is
opaque-only" above; that constraint stands. Cross-fade is not an instance of it,
and the earlier revision of this document was wrong to file it under one
heading with it.

The per-tile origin table is an RGBA32F texture using only `.xy`, so a per-tile
level and alpha have somewhere to live when either lands.

### Every deep and mid level is a full copy of the placement list

The pyramid does not decimate, so each deep or mid level stores all placements
again at 12 bytes each. `tools/verify.js` asserts this. Far levels are
negligible. Measured totals:

| design | far levels | mid levels | deep level | total | tiles | generate |
|---|---|---|---|---|---|---|
| 499,672 | 0.1 MB | 2 × 5.7 MB | 5.8 MB | 17.4 MB | 333 | 0.6 s |
| 4,990,711 | 2.4 MB | 1 × 57.1 MB | 57.8 MB | 117.3 MB | 4,068 | 4.5 s |

Wall clock, best of three, on the machine in
[renderer-findings.md](renderer-findings.md). How many mid levels a design gets
is not a constant: the 5M design gets one, because the ladder found z5's window
empty and skipped writing it - 57 MB that an older two-mid-level figure for this
same design included.

The 50M design is where this stops being an accounting note: written out it is
1,185 MB, of which the two placement-carrying levels are 1,144 MB. That is what
`--lazy` exists for, and its figures are under "placements.bin".

The rule is 12 bytes per placement per deep or mid level, plus a negligible far
tail. If total size becomes a problem the lever is quantising mid
records — tile-local coordinates at mid zoom do not need nanometre precision, and
`u16` at a per-level quantum would halve the mid levels — but it costs a
per-level quantum in the contract, so it is not done.

---

## Status

| Piece | State |
|---|---|
| `masters.bin` | done |
| deep tiles | done |
| mid tiles | done |
| far tiles, density blocks | done |
| full pyramid, all levels | done |
| coverage bitmaps | done |
| rect-count bucketing | done |
| per-level overflow lists | done |
| persistent slot buffers with a free list | done |
| layer visibility, colour modes, tile overlay | done |
| prioritised on-demand loading, prefetch ring | done |
| LRU eviction against a byte budget | done |
| LOD level chosen from zoom | done — derived ladder with hysteresis, `[` / `]` / `l` override |
| levels no zoom can select | done — solved before writing, skipped, listed in `lod.shadowed` |
| block instances, chip level | done — `chip.json`, fetched once and drawn N times |
| lazy tiles: `placements.bin`, deep and mid produced on request | done — byte-identical to written tiles, gated on that |
| several distinct blocks in one chip | in the format, not in the viewer |
| density representation, logic and filler channels | done — the filler channel is nearly flat on synthetic data, see Known gaps |
| click to identify | done - reuses tiles as the spatial index |
| jump to coordinate | done - chip coordinates, block instance resolved |
| shareable view URL | done - position, scale, level, layers, colour, solo, selection |
| instance and master names | not in the format, see Known gaps |
| named power nets, power domains | not in the format — blocked with names, and to be decided with them, see Known gaps |
| layer visibility, solo, per-layer alpha | done — alpha via ordered per-layer passes, per layer or all at once |
| selectable as an axis separate from visible | done — the panel's S column, read at the category bit in `pick()` |
| the layer panel | done — grouped rows with parent toggles, process layers and instance categories in one list |
| a stack wider than three metals | not in the generator, and the layer id space is full at 16, see Known gaps |
| colour by cell class | done — cell / macro / power / filler |
| combinational vs sequential class | not in the data model, see Known gaps |
| chip-level merged representation | not needed yet — the block's coarsest level serves the chip view; below one tile per block would need it |
| cross-fade between levels | not implemented — two opaque passes composited, see Known constraints |
| translucent layers | not planned, see Known constraints |
| deep-level cell internals | drawn, and generator-invented. A real LEF has pin shapes and obstructions and no internals — untested against real data, see Known gaps |
| degenerate generator input | done — the cases that hung or wrote an unviewable pyramid now stop with a message; see docs/roadmap.md |

Verified by `node tools/verify.js data`, which re-reads the binaries with the
same zero-parse view logic the viewer uses and checks magic numbers, versions,
alignment, exact file sizes, rect-inside-bbox, bucket partitioning and ordering,
that every placement's rect count really falls in its declared bucket, tile-local
coordinate bounds, block clipping, density range, content-box exactness,
coverage-bitmap agreement with the files on disk, that oversized placements are
promoted and undersized ones are not, and that tiles plus overflow hold exactly
`instanceCount` placements at every deep and mid level.

Benchmarked by `node tools/bench.js data`, which runs the viewer's real slot
builders over real tiles with no renderer competing for the CPU, and reports
distinct masters, draw calls and bucket padding for each level.
