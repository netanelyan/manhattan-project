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
make dev            # generate if needed, verify, serve -> http://localhost:8080/src/
make help           # every target, with parameters
```

`make` is not installed by default on Windows, so every target has an npm
mirror, and both are the same code path (`tools/dev.js`) rather than two
descriptions of the workflow that can drift:

| make | npm | what |
|---|---|---|
| `make dev` | `npm run dev` | generate if needed, verify, serve |
| `make gen` | `npm run gen` | generate `data/`, always |
| `make big` | `npm run big` | generate at 50m x 70 blocks - the scale test |
| `make block` | `npm run block` | generate a single block, no chip level |
| `make verify` | `npm run verify` | check `data/` against every invariant |
| `make check` | `npm run check` | drive the viewer headless; fail on an empty frame |
| `make serve` | `npm run serve` | serve, no regeneration |
| `make bench` | `npm run bench` | time the visible-set update outside the browser |
| `make clean` | `npm run clean` | remove `data/` |

Parameters override: `make gen COUNT=20m BLOCKS=9`, or
`npm run gen -- --count 20m --blocks 9`. Generation records what it was given,
so `make dev` regenerates when the parameters change and skips when they have
not — rebuilding 1.2 GB because someone typed `make serve` is not a good
surprise. Generation always verifies what it wrote; `--no-verify` opts out.

`--blocks N` sets how many times the chip places the block (70 by default,
`--blocks 1` for a bare block), and `--block-orient none|rows|all` how they are
oriented. `--count` accepts 100k to 50M (`500k`, `1.5M`). 500k takes 0.3s and 17.5 MB; 5M
takes 3.4s and 176 MB; a 50M design runs to about 1.2 GB, so check your disk
before asking for one. The master library is 4,634 cells, matching a real
`cells.lef`.

Viewer keys - `?` or `h` in the viewer lists them, grouped, and does not
disappear when the HUD does:

| | key | |
|---|---|---|
| navigate | drag / wheel | pan, zoom - zooming out stops at fit-to-die |
| | `f` | fit the die |
| | `g` | go to an `x, y` coordinate in nm |
| | click | identify what is under the cursor |
| | `esc` | dismiss the panel or the coordinate box |
| level | `l` | automatic / manual LOD level |
| | `[` `]` | force the level down / up (switches to manual) |
| layers | `1`-`9` | toggle a layer |
| | `shift`+`1`-`9` | solo a layer, hide the rest |
| | `a` | all layers on / off |
| | `v` | per-layer alpha, see through the stack |
| display | `d` | HUD: full / one line / off |
| | `?` `h` | the key list |
| | `c` | colour by layer or by cell class |
| | `b` | block instance outlines |
| | `p` | subpixel skip |
| diagnostics | `t` | tile bounds and content boxes overlay |
| | `r` | reset the worst-update timer |
| | `-` `=` | halve / double the tile cache budget |

Layer filters apply where layers exist. A deep tile carries real process layers;
mid and far tiles carry three abstract ones - one box per placement, or merged
density, macros and the power grid - which say what a thing is, not which mask
it is printed on. So a layer key has no referent there. The filter is ignored
rather than obeyed into an empty frame, and the viewer says so on screen instead
of leaving you to work out why `shift`+`5` blanked the die. `]` steps to a level
that does have layers.

## Hierarchy

Three levels, not two. A cell master is instanced into a block; a block is
instanced into the chip:

| | | |
|---|---|---|
| chip | N block instances (x, y, orientation) | `chip.json` |
| block | millions of placements, as a tile pyramid | `tiles/{z}/{x}/{y}.bin` |
| master | a few thousand cell definitions | `masters.bin` |

A block is parsed and tiled once; the chip is a list of transforms over that
one pyramid. The default synthetic chip places the generated block 70 times -
349 million placements at chip level, in the 117 MB the block already cost,
against ~8.2 GB flattened. At the full-chip view that is **one tile fetched and
70 draws**: the instancing the renderer already does for masters, one level up.

## Sharing a view

The URL is the view. It updates as you navigate - `replaceState` on a throttle,
so the back button leaves the page instead of walking backwards through every
pan - and loading it restores exactly what was on screen:

| parameter | |
|---|---|
| `view=x,y,scale` | camera centre in nm, and device pixels per nm |
| `z=N&auto=0` | a level held by hand; absent means the level follows the zoom |
| `mask=0x1f4` | which layers are visible |
| `solo=8` | soloed layer, with `mask` carrying what to return to |
| `color=1` | colour by cell class rather than by layer |
| `alpha=1` | per-layer alpha |
| `hud=line` `hud=off` | how much of the HUD is showing |
| `pick=x,y` | the selected placement, so "come look at this" means *this* |

That is the one thing a desktop layout viewer structurally cannot do: paste a
link into a review and have the other person land on the same rectangle.

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
what the level was built for - and one ladder covers the chip too, because a
level's cost is summed over the block instances on screen. Zoom out far enough
and only the coarsest level of each block fits, which is exactly the chip view. Each level's switch point is solved from this
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
| `tools/dev.js` | the workflow behind `make` and `npm run` |
| `tools/verify.js` | reads the binaries back and checks every viewer invariant |
| `tools/check.js` | drives the viewer headless: the runtime gate above |
| `tools/bench.js` | times the staging rebuild on real tiles, outside the browser |
| `tools/serve.js` | static file server, core Node only |
| `src/` | the viewer: plain ES modules, WebGL2, no framework |
| `src/slots.js` | the hot path: one tile to its GPU slot records |
| `src/lod.js` | switch points from zoom, solved per design, chip and canvas |
| `src/chip.js` | block instances and the block-to-chip transform |
| `tools/chip.js` | the synthetic chip: N copies of the generated block |
| `src/tiles.js` | prioritised fetch queue and LRU cache |
| `src/pool.js` | persistent GPU slot buffer with a free list |
| `spike/stress.html` | completed throughput experiment, frozen |

## The runtime gate

`make verify` reads the binaries back and checks every invariant the format has.
It cannot catch a viewer that has the right bytes on disk and still shows a black
screen, because residency, culling and the per-instance origin table only exist
once a camera is somewhere. Two bugs lived in exactly that gap - block instances
silently dropped from the visible set, and a level whose tiles are empty where a
macro was promoted to the overflow list.

So there is a second gate, and it drives the real viewer:

```sh
make check          # headless Chrome, one assertion, non-zero exit on failure
```

**At no level, anywhere inside the die, does the viewer draw nothing where
geometry exists - and the instances it culled in are the instances it drew.**

The sample points come from the data rather than from a grid over the die: the
coarsest far tile holds one block per region that has anything in it, so its
block centres are exactly the points where geometry provably exists. Added to
them is the centre of every coverage hole - a connected run of tiles that do not
exist, enclosed by tiles that do, which is where a macro was promoted out of the
tiles and the one place the tiles alone cannot answer for. Each point is visited
at every level, through one block instance per orientation the chip places, and
the frame buffer is read back at the camera position.

Then a second phase, because one of the two bugs is not reachable by sampling
levels one at a time. It needs two views in sequence - one that fills the tile
slots, and then the chip view, which draws more block instances at once than any
other - so the check drives exactly that, filling at each level up to the fetch
rail and going straight out to the whole chip. The fill scale comes from the rail
rather than from the canvas, so what the gate covers does not depend on the
window it was run in. Without that phase the check passes on the broken code;
with it, it reports `drew 46 of 70 culled-in block instances`.

It renders on SwiftShader, so it takes minutes rather than seconds, and it needs
a Chrome or an Edge - `CHROME=/path/to/chrome make check` if it is somewhere
unusual.

## Findings

[Renderer stress test findings](docs/renderer-findings.md) - draw budget measured
at ~2M instances at 60fps, making LOD and culling architectural requirements
rather than optimisations.

## Formats

[Tile format](docs/tile-format.md) - byte layout of `masters.bin` and the tile
pyramid, and why the viewer parses nothing at runtime.
