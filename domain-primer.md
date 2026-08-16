# Domain primer: what a chip layout actually is

Background reading for anyone working on Manhattan who does not come from the
semiconductor world. It assumes zero prior knowledge of chip design and builds up
to the file formats and architectural decisions the project rests on.

---

## 1. A chip is printed, not assembled

A chip is not built from parts the way a PCB is. It is printed onto a polished disc
of silicon, one layer at a time.

The process is essentially photography:

1. Coat the silicon in a light-sensitive chemical.
2. Shine light through a **mask** (a glass plate carrying an opaque pattern).
3. Wherever light landed, the chemical changes; wash those parts away.
4. Etch or deposit material into the gaps that opened up.
5. Repeat with the next mask.

Run that 60-80 times with a different mask each pass and you have built a
three-dimensional structure a few micrometres tall.

The consequence for us: **a chip design is a stack of 2D drawings**, one per mask.
Each drawing is a set of polygons, and because of how the lithography optics behave,
those polygons are almost always axis-aligned rectangles. Diagonal edges cause
resolution problems and inflate mask complexity, so digital layout is drawn strictly
at 0 and 90 degrees.

That property is called **Manhattan geometry**, after the Manhattan street grid and
the L1 distance metric named for it. It is where this project gets its name, and it
is the invariant the entire renderer exploits: everything is an axis-aligned
rectangle, so everything is one instanced unit quad.

---

## 2. What a transistor is

A transistor is a three-terminal switch. Current wants to flow from terminal A to
terminal B, and terminal C decides whether it may. Wire a few billion of those
together and you have a CPU.

Physically:

- Dope a strip of silicon so it conducts. That strip is **diffusion**.
- Lay a thin insulator over it.
- Lay a conductive wire across it, perpendicular. Historically polysilicon, so
  everyone still calls it **poly**.

That is the whole device. The poly wire is the gate (terminal C). The diffusion on
either side of it is source and drain (A and B). Apply voltage to the poly and the
silicon beneath it becomes conductive, bridging the two sides.

> **A transistor is a poly rectangle overlapping a diffusion rectangle.**
> Nothing in the layout file says "transistor here." It is an emergent property of
> two rectangles crossing.

This is the single most important fact for Manhattan's scope. Showing transistors as
*devices* rather than as colored rectangles requires computing `poly ∩ diffusion`.
That is device extraction, and it is a geometric compute job, not a parsing job.

---

## 3. The metal stack

Transistors exist only on the very bottom layer, at the silicon surface. Everything
above them is wiring.

A modern process gives you 6-15 metal layers stacked upward, separated by insulator,
connected by vertical plugs:

- **contact** - plug from metal1 down to poly or diffusion
- **via** - plug from one metal layer to the next

Metal layers alternate preferred direction by convention: metal1 horizontal, metal2
vertical, metal3 horizontal, and so on. A signal crossing the chip travels east on
metal1, up a via, north on metal2, up another via, east on metal3. Manhattan routing,
literally a taxi in a grid city.

Cross-section:

```
            metal3  ══════════════════════════════════
                          ║ via              ║ via
            metal2       ▓▓▓               ▓▓▓
                          ║ via              ║ via
            metal1  ▓▓▓▓▓▓▓▓             ▓▓▓▓▓▓▓▓
                     ║ contact             ║ contact
                              ┌────────┐
   poly (gate) ─────────────► │////////│
                     ┌────────┴────────┴────────┐
   diffusion  ─────► │ source │        │  drain │
   ═══════════════════════════════════════════════════
                        silicon substrate

   poly crossing diffusion = one transistor
   everything above the substrate is wiring
```

A layout viewer shows all of these layers projected flat, from above, in different
colors. Depth is conveyed by color and by layer visibility toggles, not by geometry.

---

## 4. Standard cells

Nobody designs a modern chip transistor by transistor. There are billions.

A foundry (TSMC, Intel, Samsung, SkyWater) ships a **standard cell library**: a few
hundred pre-designed, pre-verified micro-circuits. An inverter, a 2-input NAND, a
flip-flop, a full adder. Each is a complete layout containing 2-40 transistors.

The key constraint: **every cell has the same height**, only width varies. Cells snap
together into rows like text on a page. Power rails run along the top and bottom edge
of every cell, so butting them together connects power automatically.

A chip design is then: place millions of instances of a few hundred cell types into
rows, then wire them together.

This matters enormously for rendering. A design with 10M placements has only ~400
unique shapes. One vertex buffer per cell master, one instance buffer of positions,
a few hundred draw calls for the entire die.

---

## 5. The design flow

| Stage | What happens | Output |
|---|---|---|
| RTL | Engineer writes Verilog: `always @(posedge clk) q <= d;` | `.v` |
| Synthesis | Tool converts that into a list of standard cells and connections | gate-level netlist |
| Floorplan | Die size, macro placement, I/O pad ring | early DEF |
| Placement | Assign exact x,y to every cell instance | DEF with placement |
| Routing | Draw the actual metal wires connecting every pin | final DEF |
| Streamout | Replace each instance with its real transistor-level layout | GDSII |
| Fab | GDSII becomes masks, masks become silicon | a chip |

Manhattan sits between routing and fab: it consumes the design database and draws it.

---

## 6. The file formats

The LEGO analogy, done properly:

| File | LEGO equivalent | Contains | Typical size |
|---|---|---|---|
| **LEF** | parts catalog | Definition of each unique cell type: width, height, pin shapes, obstruction areas. Abstract, no internals. A few hundred entries. | MB |
| **DEF** | instruction manual | Where each individual instance goes, plus every wire route. Millions of records. | GB |
| **GDSII** | detailed photo of each brick | Real polygons: poly, diffusion, contacts. Where transistors live. | GB |

Put plainly:

- **LEF** says what a NAND gate looks like as a box with pins.
- **DEF** says there are 300,000 NAND gates and here is where each one sits.
- **GDSII** says what is actually inside a NAND gate.

### LEF/DEF is not hierarchical

GDSII allows cells to contain cells to contain cells, arbitrarily deep (SREF/AREF).
DEF does not. DEF is the output of place-and-route, and P&R flattens. `COMPONENTS`
is a flat list:

```
- U4231 NAND2_X1 + PLACED ( 4520 8400 ) N ;
```

So the hierarchy is exactly two levels, split across two files: a small catalog (LEF)
and a huge flat list of placements (DEF). Considerably easier than arbitrary-depth
GDSII recursion, and a direct match for GPU instancing.

### LEF/DEF contains zero transistors

LEF is an *abstract* view: bounding box, pin rectangles, obstruction rectangles. If
Manhattan only parses LEF and DEF, the deepest zoom shows featureless boxes with pin
markers and routed wires. Reaching actual transistors requires the PDK GDS for each
standard cell, of which there are only a few hundred.

This suggests the LOD architecture directly:

| Zoom level | Source | What is drawn |
|---|---|---|
| Far | DEF | Instance bounding boxes, density heatmap, `SPECIALNETS` power grid |
| Mid | DEF + LEF | Cell outlines, pin shapes, routed `NETS` per metal layer |
| Near | PDK GDS | Real cell internals, poly over diffusion, actual transistors |

The deepest tier is the differentiator. Existing browser viewers stop at the middle
tier.

---

## 7. Architectural consequences

### Parsing belongs in a native binary, not in WASM

A real DEF is 1-20GB of ASCII, and it is read approximately once per design. In the
browser you face:

- wasm32's 4GB address space ceiling (browsers effectively grant less)
- no `mmap`
- threads only via `SharedArrayBuffer` behind COOP/COEP headers

That is fighting the platform for a job that runs once. The maps world settled this
long ago: nobody parses OSM PBF in the browser, they run a native tiler offline and
serve pre-baked tiles.

```
┌───────────────────────────────────────────────────┐
│  NATIVE  (Rust CLI, rayon, mmap, full system RAM) │
│  LEF + DEF + GDS  ->  parse  ->  index  ->  tile  │
│  emits .mtn : project-defined binary format       │
└───────────────────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────┐
│  BROWSER  (Rust/WASM + WebGL2)                    │
│  fetch .mtn -> Float32Array views -> instance     │
│  buffers. Zero parsing at runtime.                │
└───────────────────────────────────────────────────┘
```

Same crate, two targets: `cargo build --release` and `wasm-pack build`.

A browser-side parser path can be added later for small designs (Tiny Tapeout, small
OpenROAD runs) so drag-and-drop works. Same parser code, streaming instead of mmap.
It should not be the starting point.

### Parallel parsing strategy

**Pass 1, single-threaded, ~GB/s.** `memchr` scan for section keywords
(`COMPONENTS`, `NETS`, `SPECIALNETS`, `PINS`, `VIAS`, `BLOCKAGES`). Record byte
offsets. Count `;` per section to get exact record counts.

**Pass 2, rayon.** Record counts are known, so preallocate SoA arrays exactly. Split
each section's byte range into N chunks, snapping each boundary forward to the next
`;` then the next `-`. Each thread parses into its own slice. No reallocation, no
locking.

Three things that will bite:

- **Names dominate memory.** 10M instances at ~30 byte names is 300MB of strings. Do
  not materialize them. Store `(offset: u32, len: u16)` into the mmap and resolve
  lazily. Intern only cell master names, of which there are a few hundred.
- **`NETS` is 60-80% of the file** and has the nastiest grammar:
  `+ ROUTED metal1 ( x y ) ( * y ) via ...` with `NEW` continuations and `*` meaning
  "same as the previous coordinate". Budget most parser effort here.
- **ASCII number parsing is the bottleneck**, not I/O. A hand-rolled integer parser
  over `&[u8]` beats `str::parse` substantially.

Target instance record: `cell_id: u16, x: i32, y: i32, orient: u8` packed to 12
bytes. 10M instances is 120MB. Fine.

### Rendering is easier than a real map engine

What Manhattan does *not* have to build:

- No map projection. Flat Cartesian plane, integer DBU coordinates. No Mercator, no
  geodesy, no datums. This is a large fraction of what makes real map engines painful.
- No style specification language. Mapbox GL spends enormous complexity on style
  expressions and runtime restyling. Manhattan has ~15 layers with fixed colors.
- No network tile fetching against a live service, no cache eviction, no live data.
- Three primitive types total, all of them rectangles: cell outlines, wire segments,
  vias.

What is genuinely hard, and will be:

1. **LOD that does not look wrong.** At full-die zoom there are hundreds of millions
   of subpixel shapes. Culling alone still hands the GPU too much. Requires
   pre-merged levels or an area budget.
2. **Label placement.** This is the actual hard problem in Mapbox GL: collision
   detection, priority, fade. Instance names and net names will surface it.
3. **f32 precision.** Coordinates are in database units, usually nanometres. A
   millimetre-scale die exceeds the 24-bit f32 mantissa (~16.7M). Deep zoom produces
   shimmer and cracks. Fix: tile-local origins, subtract in f64 on the CPU, upload
   f32 deltas. This will look like a rendering bug for days before anyone identifies
   it as precision.

### Difficulty ranking

| Component | Reality |
|---|---|
| LEF/DEF parsing | Medium. Mechanical, well-specified, parallelizes cleanly once native |
| Renderer core | Medium. No projection, no style engine, one geometry type |
| LOD + labels | **Hardest part of the project** |
| Precision handling | Sneaky hard. Presents as a rendering bug |

The unglamorous risk is building a good parser and a good renderer and having it look
bad at zoom level 0 because LOD was an afterthought. **Design the tile format and LOD
scheme before finalizing the parser output format**, because the parser should be
emitting LOD levels directly.

---

## 8. Glossary

| Term | Meaning |
|---|---|
| **DBU** | Database unit. The integer grid layout coordinates live on, usually 1nm |
| **Die** | One individual chip cut from the wafer |
| **Diffusion** | Doped, conductive silicon region. Source and drain of a transistor |
| **Poly** | Polysilicon. The gate wire crossing diffusion |
| **Contact** | Vertical plug from metal1 down to poly or diffusion |
| **Via** | Vertical plug between two metal layers |
| **Standard cell** | A pre-designed logic gate layout from the foundry library |
| **Cell master** | The unique definition; instances are placements of it |
| **Net** | An electrical connection between pins. Physically, a set of wires and vias |
| **PDK** | Process design kit. The foundry's rules, cell library, and layer definitions |
| **P&R** | Place and route. The tool stage that produces the final DEF |
| **LVS** | Layout versus schematic. Verification that extracted devices match the netlist |
| **Manhattan geometry** | All polygon edges at 0 or 90 degrees |
| **OBS** | Obstruction. Area inside a cell the router must not use |

---

## 9. Open data to develop against

- **Tiny Tapeout** - small open designs, small enough to iterate on quickly
- **SkyWater sky130 PDK** - real open standard cell GDS with real transistors
- **Intel 4004** - reverse-engineered GDS, ~2,300 transistors, small enough to fully
  extract and verify by hand
- **OpenROAD** - open P&R flow, produces matching LEF, DEF and netlists
