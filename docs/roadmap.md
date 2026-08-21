# Roadmap

What is built, what is next, and what has been decided against. Every cost in
here is a measurement taken on this repo unless it says otherwise; where a
number is an extrapolation it says so and shows what it was extrapolated from.
Estimates that predate a measurement have been replaced by the measurement.

Byte layouts and the reasoning behind each of these live in
[tile-format.md](tile-format.md); this file is about work, not format.

## Where it is

The pipeline is end to end on synthetic data: a generator that produces a
chip-scale design, a tile pyramid in three representations, a lazy path that
indexes placements instead of writing deep tiles, a WebGL2 viewer that parses
nothing at runtime, and two gates - one that reads the binaries back and one
that drives the real viewer in a browser and fails on an empty frame.

One real design has now been through it. `tools/import-def.js` reads ISPD 2015's
`mgc_superblue16_a` — 4,634 MACRO, 680,869 COMPONENTS — and builds the pyramid
through the same writer the generator uses; `verify` and `make check` pass on the
result. It is a throwaway parser aimed at questions, not the real one, and it
settled several of them at once. Full run in
[tile-format.md](tile-format.md#real-data-superblue16); the short version is
under "What real data changed", below.

## Done

| | measured at |
|---|---|
| `masters.bin`, the three tile representations, the full pyramid | 5M placements: 117 MB across 4,066 tiles in 4.5 s |
| rect-count bucketing instead of per-master draws | 8 draw calls per frame against a 4,634-master library; grouping by master needed ~4,400 |
| derived bucket caps, solved from the design's own histogram | 2.0% bucket padding on the 5M design, against 41.7% for a fixed `[8,16,32,64]` |
| per-level overflow lists for oversized features | content bleed at the 5M deep level 427 µm → 6.2 µm - one decap - and it stops growing with design size |
| coverage bitmaps, so an empty region is never requested | |
| persistent GPU slot buffers with a free list | a pan rebuilds nothing |
| prioritised fetch, prefetch ring, LRU eviction against a byte budget | 12 rapid jumps: 40 dropped, 55 aborted, 13 fetched, against 108 without supersession |
| LOD level chosen from zoom, ladder derived per design and per canvas | worst on-screen count anywhere in the range 1,531,094 rects of the 2,000,000 budget |
| levels no zoom can select are solved out before writing | z5 of the 5M design, ~57 MB not written |
| block instances, the chip level | 70 instances of a 5M block = 349M placements; chip view is **1 tile fetched, 70 draws** |
| density that reads as structure: logic and filler channels, hue ramp over the design's own p5..p95 | |
| layer visibility, solo, per-layer alpha, colour by class, tile overlay | all uniforms; nothing rebuilds a buffer |
| the layer panel: grouped rows, parent toggles, visible and selectable as separate axes | 15 rows in 5 groups, process layers and instance categories in one list; the instance categories were unfilterable at any zoom before it |
| click to identify, jump to coordinate | the tile is the spatial index; no parallel structure |
| the view in the URL | position, scale, level, layers, colour, solo, selection |
| lazy tiles: far levels plus a placement index, deep tiles produced on request | 50M design: 1,185 MB → 233 MB, 62 s → 15 s, p50 0.22 ms to produce a deep tile |
| byte-identity gate between a produced tile and a written one | all 4,068 tiles of the 5M design identical |
| `make verify`, and `make check` driving the real viewer headless | |
| degenerate generator inputs fail with a message rather than a hang or an empty pyramid | see "Unusual input", below |

## Next

Ordered by what unblocks the most.

### 1. A wider layer id space

Promoted to the top by real data, and it is now the only thing the import found
that the format cannot carry at all.

`mgc_superblue16_a/tech.lef` declares `metal1`…`metal9` and `via1`…`via8`:
**seventeen routing layers**. This format has twelve process ids in total,
because sixteen ids also have to hold nwell, diff, poly, contact, pin, macro,
power and the three instance categories. **25,250 of 74,066 library rects — 34%
— had no id and were folded onto metal3**, which is why a macro renders as one
purple slab instead of pins on metal5 over an obstruction on metal4.

**Cost:** re-cut the depth key from `1 - layer/16` to more bits, and widen
`u_layerMask` past 16. That touches the three vertex shaders, the palette, the
two half-masks the layer panel is built on, and `PROCESS_MASK`/`CATEGORY_MASK`
in `src/format.js`. Mechanical, bounded, and now backed by a measurement of what
a real stack is rather than a guess. See Known gaps in the format doc.

### 1b. What real data changed, and what is still open

`tools/import-def.js` settled four of the five questions this item used to be
about. Recorded here so the list is not read as still open:

| question | answer |
|---|---|
| are cell internals at deep zoom the right thing to draw? | **No.** A real cell is a `SIZE` box and 2–7 `metal1` pins. 4.39 rects per placement against the generator's 8.85, and the deepest level spends 4% of the rectangle budget where the synthetic worst frame spends 77% |
| how long are instance names? | 680,869 names, mean **7.14 bytes**, p95 11, 4.63 MB of text, 7.23 MB as a side table. But **anonymised** in this benchmark, so that is a floor |
| how many power nets, and what are they called? | `vdd` and `vss`, in **SPECIALNETS** — routed stripes with a width, not placements of masters. Still unanswered for a design with real domain names |
| parse throughput? | 80.3 MB read, parsed, placed and tiled in **2.4 s** single-threaded; the 75 MB DEF alone parses in 0.85 s |
| does the filler distribution assumption hold? | **Unanswerable from a floorplan.** Filler is inserted after placement, so a placer-input DEF has none, and the far tile's filler channel is identically zero |

What is still open, and now needs a *placed* design rather than another
floorplan: real placement density (this one had to be synthesized), the filler
question, and un-anonymised names.

### 1c. A design that is actually placed

Every benchmark in the ISPD 2015 archive is a placement-contest input, so all
680,450 standard cells arrive `+ UNPLACED`. `--place rows` fills the DEF's own
rows at the design's own utilisation, which is enough to exercise the pyramid at
scale but is flat where a real placement has structure — so the far levels'
density map, the one thing the whole full-die view exists to show, is the one
thing not yet tested against reality.

**Cost:** finding the file, not writing code; the importer already reads
`+ PLACED` and `+ FIXED`. An ISPD 2014/2013 incremental-timing benchmark, an
OpenROAD flow output, or the placer output for this same design would all do.

### 2. Master names

A `names.bin` of concatenated UTF-8 with a `u32` offset per master: **~60 KB for
4,634 masters**, fetched once beside `masters.bin`, resident forever. It turns
`#1149` into a cell type, which is most of what a person wants from a click.

**Cost:** small and known. Not blocked on anything. This is the cheapest real
improvement available.

### 3. Instance names, and therefore search

The expensive one, and the reason there is no search box. Two shapes:

| | cost |
|---|---|
| a `u32` offset in every placement record | 12 bytes → 16, **+33% on every deep and mid tile**, the format's largest files |
| a side file per tile, fetched only when something is clicked | one extra request on an interaction that is rare |

The side file is the better trade - identification is interactive, streaming is
not. **Blocked on item 1**: how many bytes this actually costs depends on how
long real names are, and inventing a length would be fitting to nothing.

**Decide power nets at the same time.** The format has one power layer and one
power category, and every strap in the design draws on them; a real design has
named rails, and the tool the target users have lists them individually -
`VDD`, `VSS`, `PCIE_UTIL_VPH_X4_1` and a long tail. Naming the nets is small on
its own - tens of names, not millions - but it wants a field on the placement
record or a per-tile side list, which is the same format decision instance names
make. Taking that decision without the case that most wants a field in it would
settle the record layout with a third of the problem left out of the room. See
"One undifferentiated power layer, and no named nets" in the format doc.

### 4. Several distinct blocks in one chip

`chip.json` already lists `blocks[]` and every instance names one. The viewer
loads a single master library and a single pyramid and ignores instances of any
other block, and says so in the HUD.

**Cost:** one master texture and one slot-pool set per block. Bookkeeping, not a
new idea. Nothing measured because nothing is built; the shape of the work is
known exactly.

### 5. Quantised mid records

The size lever, held in reserve. A deep or mid level is a full copy of the
placement list at 12 bytes each, and the pyramid writes two of them. Tile-local
coordinates at mid zoom do not need nanometre precision; `u16` at a per-level
quantum **halves the mid levels**.

Not done because it costs a per-level quantum in the format contract, and lazy
tiles took most of the pressure off: the 50M design is 233 MB on disk, not
1,185 MB. Reconsider if size becomes the binding constraint again.

### 6. A layer stack as wide as a real one

The generator emits three metals and two vias. A real stack is ten and ten, and
that is what the reference panel lists. The viewer side is already built for it:
the layer panel is a table of rows and groups, and the parent toggles exist
because ten metals is where a flat list stops being usable.

**Cost:** the generator side is a bigger library and more `pushRect` calls. The
format side is not free - **the layer id space is full at 16** and the depth key
is `1 - layer/16`, so twenty routing layers means re-cutting the key to more
bits, which touches the vertex shader, the palette and both half-masks. Worth
doing when a real stack says how wide it needs to be, which puts it behind
item 1. See Known gaps in the format doc.

### 7. Screenshots for the stress findings

`docs/img/` is three PNGs short and `docs/renderer-findings.md` has the image
lines commented out waiting for them. See `docs/img/README.md` for what to
capture. Trivial, and the findings doc is weaker without them.

## Not planned, and why

| | |
|---|---|
| combinational vs sequential colouring | the layer-id space is full at 16 and the depth key is `1 - layer/16`; a new class is free, a new *layer* costs a re-cut of the depth key. See Known gaps |
| translucent layers as the default | rendering is opaque-only by design; per-layer alpha is done as ordered per-layer passes instead |
| cross-fade between levels | two opaque passes composited; a scheduling gap rather than a blocked feature |
| a chip-level merged representation | not needed - the block's coarsest level serves the chip view. It becomes necessary only below one tile per block |
| `WEBGL_multi_draw` | probed at startup and reported in the HUD, not used. It would collapse draw calls, but bucketing already does that *and* gives a small fixed set of buffers, which is what makes persistent slot allocation work |
| a spatial index parallel to the tiles | a tile already is one. A parallel structure would be per level, would have to stay in step with eviction, and would answer nothing new |

## Unusual input

The generator was only ever run with plausible parameters. The degenerate cases
were tried; what they do now:

| case | now |
|---|---|
| `--count 1`, `--blocks 0` | rejected at the CLI, one line each |
| `--per-tile 0` or negative | rejected. Was an infinite loop, or a pyramid with `maxZ: null`, no tiles, and a clean `verify` |
| `--density 0:0`, `LO > HI`, `HI > 1` | rejected. `0:0` divided the die area by a mean density of zero and hung filling an infinitely tall die |
| `--buckets 0` | rejected. Was 261 verify failures from an empty cap list |
| `--seed abc`, `--block-gap` out of range | rejected. A NaN seed silently became seed 0 |
| a library of one cell master | works. The derived caps come from a histogram over placeable *cells*, which is not the whole library - the last cap is now widened to the library maximum, which is what `verify` has always asserted |
| a die far from square, or placements packed into one corner | a die 100:1 out of square made **every** level far: no level carried a placement, the cells were nowhere on disk, and `verify` passed. Now a generator error naming the remedy. Corner-packed placements were always fine |
| a master larger than a deepest tile | works - this is what overflow promotion is for, and it is the ordinary case for macros |
| a master larger than the die | `verify` fails: `overflow placement outside tile`. Left as a loud failure; it is not a design |

The two that mattered were the silent ones: an empty pyramid that verifies, and
an all-far pyramid that verifies. Both now stop generation with a message.

Half of these are not reachable through the shipped CLI at all - there is no
flag for a one-master library, for the die aspect ratio, or for where the
placements go, and the count floor is 100k. Those were driven by patching
`tools/layout.js` in a scratch copy to expose the knob, running the real
`tools/gen.js` and `tools/verify.js` over the result, and then fixing what broke
in the shipped code. The fixture is not in the repo: it exists to find the bug,
not to be maintained. What is in the repo is the guard each one produced, and
`verify` now asserts the shape of the pyramid as well as the contents of its
tiles, which is what would have caught the all-far case without a fixture at
all.
