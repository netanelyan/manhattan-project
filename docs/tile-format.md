# Tile format

The on-disk format the generator (`tools/gen.js`) writes and the viewer (`src/`)
reads. Design rule: **the viewer parses nothing.** Every bulk array is read as a
typed-array view straight over the fetched `ArrayBuffer` and handed to
`bufferData` or `texImage2D` unmodified.

This document is the contract. A producer that emits these bytes — a DEF parser,
a GDS tiler, anything — works with the existing viewer unchanged.

Format version **3**. `version` appears in both file headers and the viewer
rejects a mismatch.

| version | change |
|---|---|
| 1 | deep tiles only |
| 2 | three LOD representations (deep / mid / far) |
| 3 | deep tiles sort by rect-count bucket, not by master; per-level overflow lists |

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
  manifest.json          bootstrap metadata, the only text file
  masters.bin            cell master library, fetched once, resident forever
  tiles/{z}/{x}/{y}.bin  quadtree pyramid, one file per tile
```

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
| 16 | f32 | `density` | in `(0, 1]`, fraction of the block covered by cells |
| 20 | i32 | `layer` | 12 cellbox, 13 macrobox, 14 powerbox |
| 24 | i32 | `kind` | 0 = density, 1 = macro, 2 = power |
| 28 | i32 | — | reserved |

A far tile holds three things:

- a `BLOCK_GRID × BLOCK_GRID` grid of **density blocks** covering standard cell
  area, blocks below 0.4% coverage omitted;
- **macro blocks**, one per macro overlapping the tile;
- **power blocks**, strap segments coalesced into long runs.

Density comes from a mip chain: the finest far level bins every standard cell's
area into a `BLOCK_GRID · 2^zFarMax` raster, and coarser levels are 2×2 averages
of it. The viewer renders `palette[layer] · (0.22 + 0.78·density)`.

Keeping macros and the power grid as sharp objects rather than averaging them
into the field is the point. Averaging everything is precisely the uniform grey
the spike found at fit-to-die zoom; a density gradient with macro blocks and a
visible power grid is a readable map.

**Unlike placements, block geometry is clipped to tile bounds.** Aggregates may
be split across tiles because they carry no identity — a macro appearing as four
clipped rectangles in four tiles draws identically to one rectangle. That is why
far tiles have zero bleed.

---

## `manifest.json`

Bootstrap metadata. The only file parsed as text, fetched once.

```json
{
  "version": 2,
  "seed": 42,
  "dbuPerMicron": 1000,
  "rowHeight": 1000,
  "siteWidth": 200,
  "die":   { "w": 738600, "h": 739000 },
  "world": { "size": 739200 },
  "maxZ": 4,
  "instanceCount": 501886,
  "masterCount": 400,
  "rectCount": 8163,
  "rectTexWidth": 1024,
  "meanRectsPerInstance": 11.02,
  "meanCellWidth": 655,
  "blockGrid": 32,
  "rectBudget": 2000000,
  "bucketCaps": [8, 16, 32, 64],
  "oversizeFrac": 0.25,
  "maxRectsPerMaster": 44,
  "partial": false,
  "levels": [
    {
      "z": 4,
      "kind": "deep",
      "tilesPerSide": 16,
      "tileSize": 46200,
      "tileCount": 256,
      "recordBytes": 12,
      "rectTotal": 5514009,
      "p95PerTile": 2684,
      "maxBuckets": 3,
      "maxOverhang": 3800,
      "overflow": { "count": 426, "rectCount": 426, "bytes": 5176 },
      "coverage": "…base64…"
    }
  ]
}
```

- `partial` is true when `--one-tile` was used and only a slice exists.
- `maxOverhang` is the furthest any tile at this level draws outside its own
  bounds. The viewer expands its cull rect by it, which makes tile-granularity
  culling exact despite bleed. Overflow promotion is what keeps it to one
  standard cell.
- `overflow` describes `tiles/{z}/overflow.bin`, or is `null` if the level has
  none. Far levels never have one - their geometry is clipped.
- `bucketCaps` is the resolved bucket cap list for this library; a consumer must
  agree with it or deep tiles will draw wrong.
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

3.8 µm is one standard cell - the residual bleed of a 4 µm master against a
0.25 threshold - and it no longer grows with design size. Culling is back to
fetching the tiles it actually needs.

Two invariants hold, and `tools/verify.js` enforces both:

- Nothing is lost: tiles plus overflow are still a complete copy of the
  placement list at every deep and mid level.
- Nothing is duplicated: a placement is in a tile *or* in the overflow list,
  never both. The size test is a pure function of the master, so the two sets
  partition exactly.

The generator also sizes power strap segments to one deepest-level tile and
aligns them to tile boundaries. Real tilers split long wires at tile borders for
the same reason. Without that, tens of thousands of 25 µm strap segments
straddled tile edges and landed in the overflow list for no benefit.

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

Supporting translucency would require depth writes off and explicit
back-to-front ordering per layer — that is, drawing layer by layer, which
conflicts with grouping draws by rect-count bucket, because a bucket contains
masters whose rects span every layer. The likely resolution is a per-layer pass
over the bucket buffers (layers × buckets draw calls, so ~15 × 4 = 60 - still
tractable), with the layer mask narrowed to one layer per pass. Neither is
implemented. **The current renderer is opaque-only and the format does not carry
per-layer alpha.**

Layer *visibility* is implemented and is a different thing: `u_layerMask` is a
16-bit uniform and hidden layers collapse their vertices, which needs no
ordering guarantees.

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
| 503,823 | 0.1 MB | 2 × 5.8 MB | 5.8 MB | 17.5 MB | 334 | 0.3 s |
| 5,037,605 | 2.4 MB | 2 × 57.7 MB | 58.0 MB | 175.8 MB | 4,984 | 3.4 s |

(Version 2 figures for a 50M design: 1.26 GB across 21,845 tiles in 43 s.)

The rule is 12 bytes per placement per deep or mid level, plus a negligible far
tail; how many mid levels a design gets depends on where `MIN_CELL_PX` and the
rect budget fall. If total size becomes a problem the lever is quantising mid
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
| LOD level chosen from zoom | not yet — manual `[` / `]` in the viewer (step 4) |
| cross-fade between levels | not implemented — two opaque passes composited, see Known constraints |
| translucent layers | not planned, see Known constraints |

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
