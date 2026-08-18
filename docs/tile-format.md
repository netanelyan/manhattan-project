# Tile format

The on-disk format the generator (`tools/gen.js`) writes and the viewer (`src/`)
reads. Design rule: **the viewer parses nothing.** Every bulk array is read as a
typed-array view straight over the fetched `ArrayBuffer` and handed to
`bufferData` or `texImage2D` unmodified.

Status: instance tiles are implemented and emitted. The block tile layout below
is fixed but not yet produced — see [Status](#status).

## Conventions

- **Little-endian** throughout. No big-endian fallback; every platform the
  viewer targets is LE.
- **Integer nanometres** for all coordinates. `dbuPerMicron` is carried in the
  header, but the generator always uses 1000.
- **4-byte alignment.** Every array starts at an offset divisible by 4 and every
  record is a whole number of 4-byte words, so `new Int32Array(buf, off, n)`
  never throws.
- Field tables below give byte offsets from the start of the record.
- `u8`/`u16`/`u32`/`i32`/`f32` are the obvious C types.

## File tree

```
data/
  manifest.json          bootstrap metadata, the only text file
  masters.bin            cell master library, fetched once, resident forever
  tiles/{z}/{x}/{y}.bin  quadtree pyramid, one file per tile
```

Tile `(z, x, y)` covers world nm
`[x·S, (x+1)·S) × [y·S, (y+1)·S)` where `S = world.size / 2^z`.
`world.size` is chosen as an exact multiple of `2^maxZ`, so `S` is always a whole
number of nanometres at every level and tile origins are exact.

**Every tile is independently renderable given only `masters.bin`.** No tile
references another tile.

---

## `masters.bin`

The cell master library: ~400 unique cell types, each a list of rectangles in
cell-local nanometres. This is what gets instanced — a design with 10M
placements still has only these ~400 shapes.

### Header (32 bytes)

| off | type | field | notes |
|---|---|---|---|
| 0 | u32 | `magic` | `0x4D4E544D`, i.e. `"MTNM"` in file byte order |
| 4 | u16 | `version` | 1 |
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
this; the renderer's orientation transforms assume it.

### Rect record (32 bytes, 8 × i32)

| off | type | field | notes |
|---|---|---|---|
| 0 | i32 | `x` | cell-local nm |
| 4 | i32 | `y` | |
| 8 | i32 | `w` | > 0 |
| 12 | i32 | `h` | > 0 |
| 16 | i32 | `layer` | see layer table below |
| 20 | i32 | `flags` | bit 0 = pin, bit 1 = obstruction |
| 24 | i32 | — | reserved |
| 28 | i32 | — | reserved |

**Why 32 bytes.** The rect table is uploaded verbatim as an `RGBA32I` texture
1024 texels wide: each rect is exactly **two texels**, so rect `r` lives at
texel `2r`, addressed as `ivec2(t & 1023, t >> 10)`. The vertex shader turns
`gl_VertexID` into `(rect index, quad corner)` and `texelFetch`es the geometry.
That is why there are no per-master vertex buffers and no CPU-side geometry
expansion: `masters.bin`'s rect table goes to the GPU as-is, padded only to fill
the last texture row.

### Layers

| id | name | id | name |
|---|---|---|---|
| 0 | outline | 6 | via1 |
| 1 | nwell | 7 | metal2 |
| 2 | diff | 8 | metal3 |
| 3 | poly | 9 | pin |
| 4 | contact | 10 | macro |
| 5 | metal1 | 11 | power |

The layer id doubles as the depth key: the vertex shader emits
`z = 1 - layer/16`, so metal draws over poly draws over diffusion with the depth
test doing the sorting. Draw call order is therefore free — which is what lets
draws be grouped by master rather than by layer.

---

## `tiles/{z}/{x}/{y}.bin`

Two tile kinds share one 64-byte header. `kind` selects the payload.

### Header (64 bytes)

| off | type | field | notes |
|---|---|---|---|
| 0 | u32 | `magic` | `0x544E544D`, i.e. `"MTNT"` |
| 4 | u16 | `version` | 1 |
| 6 | u16 | `kind` | 0 = instances, 1 = blocks |
| 8 | u8 | `z` | |
| 9 | u8 | — | reserved |
| 10 | u16 | `groupCount` | master groups; 0 for block tiles |
| 12 | u32 | `count` | instances, or blocks |
| 16 | i32 | `originX` | world nm of the tile's min corner |
| 20 | i32 | `originY` | |
| 24 | i32 | `tileSize` | tile extent in nm (square) |
| 28 | u32 | `rectCount` | master rects this tile draws; 0 for block tiles |
| 32 | i32 | `contentMinX` | tile-local bbox of geometry actually drawn |
| 36 | i32 | `contentMinY` | |
| 40 | i32 | `contentMaxX` | |
| 44 | i32 | `contentMaxY` | |
| 48 | u32 | `groupsOff` | byte offset of the group table (64) |
| 52 | u32 | `dataOff` | byte offset of the record array |
| 56 | u32 | `tx` | |
| 60 | u32 | `ty` | |

`rectCount` is the tile's true GPU cost — the stress-test budget of ~2M is
measured in **rectangles**, not placements — so LOD selection sums `rectCount`
over candidate tiles rather than `count`.

`contentMin/Max` exists because instances are assigned to a tile by their
**origin corner**, so a tile's geometry can extend past `tileSize`. Viewport
culling must test the content box, not the tile box. See
[Content bleed](#content-bleed).

### Instance tile payload (`kind == 0`)

Group table at `groupsOff`, `groupCount` records of 16 bytes:

| off | type | field | notes |
|---|---|---|---|
| 0 | u32 | `masterId` | strictly ascending across the table |
| 4 | u32 | `start` | first instance index; groups are contiguous from 0 |
| 8 | u32 | `count` | > 0 |
| 12 | u32 | `rectCount` | `count × master.rectCount`, precomputed |

Instance array at `dataOff`, `count` records of 12 bytes, **sorted by master id**
so each group is one contiguous slice:

| off | type | field | notes |
|---|---|---|---|
| 0 | i32 | `x` | tile-local nm, in `[0, tileSize)` |
| 4 | i32 | `y` | tile-local nm, in `[0, tileSize)` |
| 8 | u16 | `masterId` | |
| 10 | u8 | `orient` | LEF orientation, 0..7 |
| 11 | u8 | `flags` | reserved, 0 |

Bytes 8..11 are read as one `i32`: `masterId = w & 0xffff`,
`orient = (w >>> 16) & 0xff`, `flags = w >>> 24`.

Sorting by master is what makes one draw call per master possible across
*several* tiles at once: the viewer concatenates each tile's group `m` into a
single staging buffer, so master `m` needs exactly one `drawArraysInstanced`
regardless of how many tiles contributed.

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

Rotated orientations (2, 3, 6, 7) swap the placed bounding box to `H × W`. The
generator currently emits only N and FS (standard cell rows alternate so power
rails abut) and N for macros and straps; the shader implements all eight.

### Block tile payload (`kind == 1`) — reserved

Coarse levels replace instances with pre-merged aggregate rectangles carrying a
density value, which is what fixes the grey-mud problem the spike identified. No
group table; `groupCount` is 0 and `dataOff == groupsOff`.

`count` records of 32 bytes:

| off | type | field | notes |
|---|---|---|---|
| 0 | i32 | `x` | tile-local nm |
| 4 | i32 | `y` | |
| 8 | i32 | `w` | |
| 12 | i32 | `h` | |
| 16 | f32 | `density` | 0..1, fraction of the block covered by cells |
| 20 | i32 | `layer` | |
| 24 | i32 | `kind` | 0 = std cell region, 1 = macro, 2 = power |
| 28 | i32 | — | reserved |

---

## `manifest.json`

Bootstrap metadata. The only file the viewer parses as text, fetched once.

```json
{
  "version": 1,
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
  "partial": true,
  "levels": [
    { "z": 4, "kind": "instances", "tilesPerSide": 16, "tileSize": 46200,
      "tiles": [[5, 10]] }
  ]
}
```

`partial` is true when `--one-tile` was used and only a slice of the pyramid
exists. `levels[].tiles` enumerates the tiles that were actually written, so the
viewer never requests a 404.

---

## Content bleed

Instances are bucketed into a tile by their **origin corner**, not clipped to
tile bounds. A cell whose origin sits just inside a tile edge draws past it. The
overhang is bounded by the largest master, and at the deepest level that bound is
not small:

| master class | size | overhang vs a 46.2 µm deepest tile |
|---|---|---|
| standard cell | ≤ 4 µm wide | ~9 % |
| power strap segment | 25 µm long | **~54 %** |
| memory macro | 100 µm+ | exceeds a tile entirely |

Consequences, both handled by `contentMin/Max` rather than by clipping:

- **Culling** tests the content box, so it is correct but conservative — a tile
  is fetched slightly before its cells enter the viewport.
- **Double draw** cannot happen: an instance lives in exactly one tile, so
  neighbouring tiles never draw the same rectangle twice.

The alternative — clipping geometry at tile borders — would duplicate instances
across tiles and break the "one draw call per master" grouping, so bleed is the
deliberate choice. If the overhang becomes a problem, the fix is to shorten
power strap segments so they subdivide at deepest-tile boundaries, not to clip.

---

## Status

| Piece | State |
|---|---|
| `masters.bin` | done |
| instance tile, deepest level | done |
| full pyramid | not yet — one tile only, `partial: true` |
| middle levels (small masters dropped) | not yet |
| block tiles | layout fixed above, not emitted |

Verified by `node tools/verify.js data`, which re-reads the binaries with the
same zero-parse view logic the viewer uses and checks magic numbers, alignment,
exact file sizes, rect-inside-bbox, group partitioning and ordering, per-instance
master agreement, tile-local coordinate bounds, and content-box exactness.
