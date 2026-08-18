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
node tools/gen.js --count 500k --one-tile   # write data/ (~0.3s)
node tools/verify.js data                   # check the binaries round-trip
node tools/serve.js                         # http://localhost:8080/src/
```

`--count` accepts 100k to 50M (`500k`, `1.5M`). Generating 50M placements takes
about 7s. Drag to pan, wheel to zoom, `f` to fit, `p` to toggle subpixel skip.

## Layout

| Path | What |
|---|---|
| `tools/gen.js` | tile generator CLI |
| `tools/layout.js` | synthetic layout: master library, density field, placement |
| `tools/format.js` | binary layout constants shared with the docs |
| `tools/verify.js` | reads the binaries back and checks every viewer invariant |
| `tools/serve.js` | static file server, core Node only |
| `src/` | the viewer: plain ES modules, WebGL2, no framework |
| `spike/stress.html` | completed throughput experiment, frozen |

## Findings

[Renderer stress test findings](docs/renderer-findings.md) - draw budget measured
at ~2M instances at 60fps, making LOD and culling architectural requirements
rather than optimisations.

## Formats

[Tile format](docs/tile-format.md) - byte layout of `masters.bin` and the tile
pyramid, and why the viewer parses nothing at runtime.
