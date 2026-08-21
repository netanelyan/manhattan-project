# Manhattan

A chip-layout renderer built on one invariant: digital layout is Manhattan
geometry, so everything on screen is an axis-aligned rectangle.

## What it does

Opens a chip layout in a browser tab and lets you navigate it - pan, zoom from
the whole die down to the rectangles inside a single cell, toggle layers, click
a cell to see what it is, and paste the resulting URL into a review so someone
else lands on the same rectangle.

It does that at a scale that does not fit on a GPU, which is the whole problem.
Designs of tens of millions of placements can never be handed to the renderer
whole, so the data is a **tile pyramid in three representations** - full cell
internals at the deepest levels, one outline per cell in the middle, merged
density blocks at the top - and the viewer picks a level from the zoom on a
rectangle budget. Tiles are binary, laid out so the viewer takes typed-array
views straight over the bytes and **parses nothing at runtime**.

Most of it runs on a synthetic generator, and one real design has now been
through it — ISPD 2015's `mgc_superblue16_a`, 4,634 real MACRO and 680,869 real
COMPONENTS, via `tools/import-def.js`. It moved the numbers: see
[Real data](#real-data) below, and the section of the same name in
[docs/tile-format.md](docs/tile-format.md) for what the format got wrong.

New to chip design? Start with the [domain primer](domain-primer.md) - it builds
up from "a chip is printed, not assembled" to the file formats and architectural
decisions this project rests on, assuming zero semiconductor background.

## The numbers

| | |
|---|---|
| **draw budget** | ~2M rectangles at 60fps, measured on an RTX 4060 at 3440x1440 ([findings](docs/renderer-findings.md)). This is the constraint everything else answers to |
| **worst frame in the zoom range** | 1,531,094 rectangles, 77% of that budget, at the deepest level just before it is given up |
| **draw calls** | 8 per frame inside a block, against a 4,634-master library - they group by rect-count bucket, not by master, so the count does not track library size |
| **block instancing** | a 5M-placement block placed 70 times is 349M placements at chip level, in the block's 117 MB rather than ~8.2 GB flattened. At the full-chip view that is **1 tile fetched and 70 draws** |
| **scale tested at** | a 50M-placement block, 70 instances - 3.5 billion placements at chip level. Written out it is 1,185 MB in 62 s; with deep tiles produced on demand it is 233 MB in 15 s, and a produced tile is byte-identical to a written one |
| **default dev design** | 5M placements, 117 MB, 4.5 s to generate |

One number from somewhere else, for scale, and it is an observation rather than
a measurement taken here: the status bar of Ansys RedHawk-SC - the tool the
target users actually have open - was seen reading `Mem: 9.0GB` and
`Refresh Time: 0.05s`. Nine gigabytes resident is a different architecture from
one that streams tiles against a 64 MB cache, and it is consistent with the slow
load times reported for it. That it puts a refresh time on screen at all says
the number is one those users watch, which is the same reason the HUD here
carries frame and update timings.

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
| `make lazy` | `npm run lazy` | far levels plus an index; deep tiles on demand |
| `make warm` | `npm run warm` | materialise lazy tiles ahead of time |
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
surprise. Generation always verifies what it wrote; `--no-verify` opts out. Every
parameter states its range and is rejected outside it, because the interesting
failures are not errors: `--per-tile 0` used to loop forever and `--density 0:0`
used to divide the die area by zero and fill an infinitely tall die.

`--blocks N` sets how many times the chip places the block (70 by default,
`--blocks 1` for a bare block), and `--block-orient none|rows|all` how they are
oriented. `--count` accepts 100k to 50M (`500k`, `1.5M`). 500k takes 0.6 s and 17.4 MB; 5M
takes 4.5 s and 117 MB; a 50M design runs to about 1.2 GB, so check your disk
before asking for one - or use `make lazy`, below, which is 233 MB and 15 s. The master library is 4,634 cells, matching a real
`cells.lef`.

Viewer keys - `?` or `h` in the viewer lists them, grouped, and does not
disappear when the HUD does:

| | key | |
|---|---|---|
| navigate | drag / wheel | pan, zoom - zooming out stops at fit-to-die |
| | `f` | fit the die |
| | `g` | go to an `x, y` coordinate in nm |
| | click | identify what is under the cursor |
| | `esc` | dismiss the identify readout or the coordinate box |
| designs | `o` | pick a design, import a LEF/DEF, generate a synthetic one |
| level | `l` | automatic / manual LOD level |
| | `[` `]` | force the level down / up (switches to manual) |
| layers | `shift`+`l` | the layer panel |
| | `1`-`9` `0` | toggle a layer, reading down the panel |
| | `shift`+`1`-`9` | solo a layer, hide the rest of its half of the stack |
| | `a` | all layers on / off |
| | `v` | see through every layer that has a preset; the panel does one at a time |
| display | `d` | HUD: full / one line / off |
| | `?` `h` | the key list |
| | `c` | colour by layer or by cell class |
| | `b` | block instance outlines |
| | `p` | subpixel skip |
| diagnostics | `t` | tile bounds and content boxes overlay |
| | `r` | reset the worst-update timer |
| | `-` `=` | halve / double the tile cache budget |

## The layer panel

Keys were the whole layer interface, and a key you have to remember is a key
nobody presses. So the layers now have a panel, top right and on by default -
grouped rows, a parent toggle per group, and three columns. `shift`+`l` puts it
away again.

| | |
|---|---|
| **V** | visible |
| **S** | selectable: whether a click can land on it. Showing a macro and letting it swallow every click on the cells under it are different questions |
| **C** | the layer's colour, and clicking it makes that one layer see-through. `v` is the same thing for all of them at once |

The rows are one list, and it holds both kinds of thing the layer id space
carries: the **process layers** a deep tile is made of - metal2, poly, contact -
and the three **instance categories** a mid or far tile is made of - cells,
macros, the power grid. So "what kind of thing" and "which mask is it printed
on" share one control surface instead of being a layer key in one place and a
colour mode in another.

A level carries one half of that list or the other, never both, and the rows
that have no referent at the level on screen are **dimmed rather than removed** -
the state is still yours to set, and it applies the moment you zoom to where it
means something. That is the per-row version of a message the viewer used to
have to put in the corner. The half a level does not carry is left fully on
rather than obeyed into an empty frame; a solo stays inside its own half for the
same reason.

Hiding all three instance rows at the chip view does now blank the screen,
because there it is the whole of what is drawn. That is the filter working.

**S is inert on the twelve process rows**, at every level, and shown as inert
rather than as a control that does nothing: a click identifies a placement, never
one of its rectangles, so there is no such thing as picking metal2.

The model is taken from RedHawk-SC's layer panel, which is what these users have
open all day - grouped rows with parent toggles, V and S as separate columns, and
instance categories listed alongside physical layers. Theirs has a fourth column,
M, whose meaning is not known here; `COLUMNS` in `src/panel.js` is where it goes
when it is.

## More than one design

A design is a directory of tiles, and there is more than one of them now. The
server holds them all, and the URL says which one you are looking at:

```sh
node tools/serve.js --data data-sb16     # prints the URL with ?data= on it
```

| | |
|---|---|
| `?data=<dir>` | names the design, alongside every other view parameter. A bare name is a directory at the server root; a leading `/`, a `.`, or a full URL is taken as given |
| `o` in the viewer | the picker: every design on disk with its placement count, die size, source and bytes, plus forms to import or generate one |
| `make dev DATA=data-sb16` | serve a chosen one from the workflow |

**Switching designs resets the camera.** A position that meant something on a
2.47 x 2.47 mm die means nothing on a 1.49 x 1.62 mm one, and carrying it across
leaves you in empty space reading `placements 0` with nothing on screen to say
why. The picker drops the camera keys and keeps the display ones — layers,
colour, HUD mode. A hand-edited link that carries a stale `view=` is checked on
arrival: if the camera cannot see any of the design, it is ignored, the die is
fitted, and the HUD says so.

**A design this generator did not write is never regenerated over.** An imported
pyramid has no `.gen-params` stamp, so `make dev DATA=data` used to read
"unknown parameters" and replace a real design with a synthetic one. It now
refuses and names the flag: `FORCE=1`.

### Import and generate from the browser

`o` also opens a drop zone. Give it a benchmark directory — or `cells.lef`,
`tech.lef` and `floorplan.def` — and the server runs **the same
`tools/import-def.js` the CLI runs** and streams its stdout back into the panel.
The generator has a form beside it over `tools/gen.js`.

There is no parser in the browser and no second writer. Tiling is an offline job
by design: it happens once, in a process, and an 89 GB DEF was never going to be
held in a tab. What the browser path removes is the flag syntax, not the
architecture.

- the importer's own output is what you read — the layer table, the master
  stats, the derived bucket caps, the `PLACEMENT SYNTHESIZED` banner. Those
  numbers are the most useful thing either tool produces and they were CLI-only
- a floorplan DEF is refused with the remedy, not an error code: *tick "place
  into the DEF rows" and import again*
- the flags that matter are on the form: place, no SIZE box, per-tile, lazy
- **256 MB per file, 600 MB per import.** Not caution: `tools/import-def.js`
  reads each file into one JavaScript string and V8 caps a string at about
  512 MB, so a file that size does not go through it on the CLI either. That is
  what a streaming parser is for, and this is not one
- because those routes start processes, the server binds to `127.0.0.1` unless
  `--host` says otherwise, and `--no-jobs` turns them off

## Real data

Every number in this repo used to come from a generator written to match the
format, while the format was written to match the generator. `tools/import-def.js`
breaks that loop by reading a file nobody here wrote:

```sh
node tools/import-def.js --dir path/to/mgc_superblue16_a --place rows --out data-sb16
node tools/dev.js check --data data-sb16
```

It is deliberately throwaway — the parser that matters is being written
elsewhere — and it parses only `MACRO/SIZE/CLASS/PIN/OBS` out of `cells.lef` and
`UNITS/DIEAREA/ROWS/COMPONENTS` out of the DEF, then hands the same design object
`tools/layout.js` produces to the same writer. The benchmark is not in this repo;
it is [the ISPD 2015 contest archive](http://www.ispd.cc/contests/15/web/benchmarks/ispd_2015_contest_benchmark.tgz).

**Two things it found immediately.**

`floorplan.def` has no placement in it. ISPD 2015 was a *placement* contest, so
its benchmarks are placer inputs: 680,450 components are `+ UNPLACED` and the
only 419 with coordinates are the macros. `--place rows` fills the DEF's own rows
at the design's own 47.6% utilisation and the manifest records that it did; the
import refuses to run without the flag. Library, die, rows, master mix, instance
names and the fixed macros are real. Which row and which x are not.

And **a real cell is a box and a handful of pins.** That is what LEF is:

| | synthetic | superblue16 |
|---|---|---|
| **rects per placement** | **8.85** | **4.39** (3.39 without the `SIZE` box) |
| max rects per master | 44 | **4,461** — a macro's OBS block |
| rect-count spread | unimodal 1…44 | **bimodal**: 4,584 cells at 3…8, 50 macros at up to 4,461 |
| derived bucket caps | `[3,5,9,10,14,24,32,44]` | `[3,4,5,6,8,118,676,4461]` |
| bucket padding | 2.0% | **0.2%** (a fixed `[8,16,32,64]` would be 45.2%) |
| levels written | 6 | **3** — z2 far, z3 mid, z4 deep |
| deepest level, share of the 2M budget | 77% at its worst frame | **4%** |
| on disk | 117 MB | 15.9 MB |
| parse + place + tile, 80.3 MB in | — | **2.4 s** |

Instance names, the measurement three deferred features were waiting on:
680,869 names, 4.63 MB of UTF-8, mean 7.14 bytes, p95 11, 7.5% hierarchical —
**7.23 MB as a side table**, or +2.72 MB per deep/mid level in the record. The
names in this benchmark are anonymised (`o12345`, `MAS4633`), so 7.14 bytes is a
floor.

`docs/tile-format.md` has the full run under **Real data: superblue16**,
including the five things the format got wrong — the layer id space being 12
process ids against a real 17-layer stack (34% of rects folded onto metal3), the
power grid not being placements of masters at all, two of the four master
classes having no LEF referent, a runtime gate that assumed a square die, and a
pin flag nothing reads.

## Lazy tiles

The deep levels are almost all of the pyramid and almost none of what anyone
looks at. On the 50M design, z6 and z7 are 1,144 MB of 1,182 MB - 96% - and a
session opens a few hundred of their 18,686 tiles. Extrapolated to a real block
of ~11 billion placements that is ~270 GB and about four hours of generation,
the overwhelming majority of it deep tiles nobody will ever open. That, not
rendering and not parsing, is what stops the real target.

So generation splits in two:

| | what | why |
|---|---|---|
| **eager** | the far levels, every level's overflow list, `masters.bin` | small, and everyone sees them the moment they open the viewer |
| **lazy** | every deep and mid level | one full copy of the placement array each, and mostly never read |

```sh
make lazy           # then make serve, or make dev, exactly as before
```

What replaces them is `placements.bin`: the placement list grouped by deepest
tile, with a count per tile. A tile at level `z` is one contiguous range per row
of the `2^(maxZ-z)` square of deepest tiles it covers, so producing it is a
positional read and a call into the same builder full generation uses. The
viewer is not told and needs no change - it asks for `tiles/{z}/{x}/{y}.bin` the
way it always did, and `tools/serve.js` builds one when the file is not there.

Measured on the 50M design:

| | full | lazy |
|---|---|---|
| on disk | 1,185 MB | 233 MB (39 MB far, 190 MB index) |
| generation | 62 s | 15 s |
| producing one deep tile | - | p50 0.22 ms, p99 0.42 ms |
| producing one mid tile | - | p50 0.35 ms, p99 0.67 ms |

A produced tile is indistinguishable from a static one over HTTP: p50 15.56 ms
against 15.55 ms for the same tile read off disk, on the same server, in the
same loop. The 15 ms is the request; the tile is the 0.2 ms inside it. The
viewer's fetch path needs no adjusting because there is nothing to adjust for.

The index is one copy of the placement array at 4 bytes a placement, against the
12 bytes a tile record needs - coordinates relative to the deepest tile and on
the placement grid, plus a master id and an orientation, in one 32-bit word. The
grid is measured from the data and range-checked, never assumed.

**The gate is byte-identity.** A tile produced from the index has to be the tile
full generation would have written - not equivalent, identical - or lazy and
eager tiles are not interchangeable and `verify` covers only one of them. So
generation builds a sample of tiles both ways and compares the bytes before it
finishes, `tools/verify.js` produces every lazy tile and checks it exactly as it
checks a written one, and `tools/materialise.js --all` will write the lot out for
a full comparison. On the 5M design all 4,068 tiles come out identical.

That gate is not paranoia. The bug it caught was a tile origin that is not a
multiple of the row height, which makes `y - origin` off-grid even when every
`y` is on it: every tile below the first row was 200nm out. The tiles still
verified - consistent headers, consistent content boxes, consistent bucket
tables - and `make check` still passed, because 200nm is subpixel. Only the byte
comparison saw it.

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
| `data=data-sb16` | which design - a directory on the server |
| `view=x,y,scale` | camera centre in nm, and device pixels per nm |
| `z=N&auto=0` | a level held by hand; absent means the level follows the zoom |
| `mask=0x1f4` | which layers are visible |
| `sel=0xcfff` | which layers a click can land on |
| `solo=8` | soloed layer, with `mask` carrying what to return to |
| `color=1` | colour by cell class rather than by layer |
| `alpha=0x80` | which layers are see-through (`alpha=1`, from older links, means all of them) |
| `panel=0` | the layer panel put away |
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
| `tools/gen.js` | tile generator CLI, and `buildDesign` - the writer both paths share |
| `tools/import-def.js` | reads a real LEF/DEF into the same design object. Throwaway; see Real data |
| `tools/layout.js` | synthetic layout: master library, density field, placement |
| `tools/pyramid.js` | level planning, bucketing, the three tile builders |
| `tools/format.js` | binary layout constants shared with the docs |
| `tools/dev.js` | the workflow behind `make` and `npm run` |
| `tools/verify.js` | reads the binaries back and checks every viewer invariant |
| `tools/pindex.js` | `placements.bin`: the index deep and mid tiles are produced from |
| `tools/lazy.js` | producing one tile from the index, byte-identical to a written one |
| `tools/materialise.js` | writing lazy tiles ahead of time, and timing them |
| `tools/check.js` | drives the viewer headless: the runtime gate above |
| `tools/bench.js` | times the staging rebuild on real tiles, outside the browser |
| `tools/serve.js` | static file server, core Node only |
| `src/` | the viewer: plain ES modules, WebGL2, no framework |
| `src/panel.js` | the layer panel: the row model, and what a row means at each level |
| `src/designs.js` | the design picker, and the two forms that make a design |
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
pyramid, and why the viewer parses nothing at runtime. Its **Known gaps**
section is what the format cannot answer: no names and therefore no search, one
undifferentiated power layer where a real design has named rails, a class split
the layer id space has no room for, a stack three metals wide that cannot widen
without re-cutting the depth key, a filler channel the synthetic data barely
exercises, and cell internals at deep zoom that a real LEF does not have.

## Where it is going

[Roadmap](docs/roadmap.md) - what is built and what it measured, what is next
and what each one costs, and what has been decided against. The short version:
nothing here has read a real LEF/DEF yet, and most of the open items are waiting
behind that one.
