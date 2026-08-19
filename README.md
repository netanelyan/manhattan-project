# Manhattan

A chip-layout renderer built on one invariant: digital layout is Manhattan
geometry, so everything on screen is an axis-aligned rectangle.

New to chip design? Start with the [domain primer](domain-primer.md) - it builds
up from "a chip is printed, not assembled" to the file formats and architectural
decisions this project rests on, assuming zero semiconductor background.

## Background

[Domain primer](domain-primer.md) - chip design context for anyone not from the
semiconductor world.

## Running it

No dependencies, no build step. Node for the generator, a browser for the viewer.

```sh
node tools/gen.js --count 500k   # write data/ (0.2s, 341 tiles, 18.5 MB)
node tools/verify.js data        # check every invariant the viewer relies on
node tools/bench.js data         # time the staging rebuild
node tools/serve.js              # http://localhost:8080/src/
```

`--count` accepts 100k to 50M (`500k`, `1.5M`). 500k takes 0.3s and 17.5 MB; 5M
takes 3.4s and 176 MB; a 50M design runs to about 1.2 GB, so check your disk
before asking for one. The master library is 4,634 cells, matching a real
`cells.lef`.

Viewer keys:

| key | |
|---|---|
| drag / wheel | pan, zoom |
| `l` | automatic / manual LOD level |
| `[` `]` | force the level down / up (switches to manual) |
| `f` | fit the die |
| `1`-`9` | toggle a layer |
| `a` | all layers on / off |
| `c` | colour by layer or by cell class |
| `t` | tile bounds and content boxes overlay |
| `p` | subpixel skip |
| `r` | reset the worst-update timer |
| `-` `=` | halve / double the tile cache budget |

## LOD

The pyramid does not decimate, it changes representation - dropping small cells
would leave holes in cells still large enough to see. Each level carries one of
three forms, chosen by the generator from the rectangle budget and how many
pixels a cell covers:

| | what a tile holds | rects per placement | draw calls |
|---|---|---|---|
| **deep** | full master internals | ~11 | one per rect-count bucket (4) |
| **mid** | one cell outline per placement | 1 | one |
| **far** | merged density blocks, macros and power grid | n/a | one |

The viewer picks its level from the zoom on the same basis, so what is drawn is
what the level was built for. Each level's switch point is solved from this
design's tile sizes and per-tile rectangle cost and from the live canvas size -
they are not constants, and a bigger window moves them - with a 1.3x hysteresis
band so the level does not flicker when the camera parks on a boundary. On a
5M-placement design at 3424x1345 the worst on-screen count anywhere in the zoom
range is 1.49M rectangles against the 2M budget, and mid geometry is given up at
exactly 1.5 px per cell, before it turns into noise.

Two things keep those numbers flat as designs grow. Deep draws group by
*rect-count bucket*, not by master, so the draw count does not track library
size - grouping by master needed ~4,400 calls per frame at 4,634 masters.
And features too big for a level's tiles are promoted to a per-level overflow
list, so content bleed stays at one standard cell instead of one macro, which
otherwise inflated the tiles fetched per frame by up to 50x.

Full byte layouts, the level assignment rule, and the measurements behind both
are in [docs/tile-format.md](docs/tile-format.md).

## Layout

| Path | What |
|---|---|
| `tools/gen.js` | tile generator CLI |
| `tools/layout.js` | synthetic layout: master library, density field, placement |
| `tools/pyramid.js` | level planning, bucketing, the three tile builders |
| `tools/format.js` | binary layout constants shared with the docs |
| `tools/verify.js` | reads the binaries back and checks every viewer invariant |
| `tools/bench.js` | times the staging rebuild on real tiles, outside the browser |
| `tools/serve.js` | static file server, core Node only |
| `src/` | the viewer: plain ES modules, WebGL2, no framework |
| `src/slots.js` | the hot path: one tile to its GPU slot records |
| `src/lod.js` | switch points from zoom, solved per design and per canvas |
| `src/tiles.js` | prioritised fetch queue and LRU cache |
| `src/pool.js` | persistent GPU slot buffer with a free list |
| `spike/stress.html` | completed throughput experiment, frozen |

## Findings

[Renderer stress test findings](docs/renderer-findings.md) - draw budget measured
at ~2M instances at 60fps, making LOD and culling architectural requirements
rather than optimisations.

## Formats

[Tile format](docs/tile-format.md) - byte layout of `masters.bin` and the tile
pyramid, and why the viewer parses nothing at runtime.
