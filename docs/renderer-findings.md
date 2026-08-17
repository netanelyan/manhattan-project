# Renderer stress test: findings

## Question asked

Can WebGL2 instanced rendering sustain 60fps drawing millions of axis-aligned
rectangles under pan and zoom, in a browser tab?

## Method

Synthetic layout data - integer nanometre coordinates, uniform-height cells in
rows, widths 400-4000nm on a 200nm grid, ~8 cell types, seeded PRNG. One unit
quad, per-instance attributes via `vertexAttribDivisor`, single
`drawArraysInstanced` call. Measurement is a scripted 5-second circular camera
pan, reporting min/avg/max frame time. Manual panning was not used for
measurement.

## Hardware

| | |
|---|---|
| GPU | NVIDIA GeForce RTX 4060 (driver 32.0.15.8129) |
| CPU | Intel Core i7-9700 @ 3.00GHz, 8 cores / 8 threads |
| RAM | 32 GB |
| OS | Windows 11 Pro, build 26100 |
| Browser | Opera 133.0.5932.85 (Chromium 133) |
| Display | 3440x1440 @ 60 Hz |

Numbers are meaningless without this. The benchmark renders at full window size,
so the 3440x1440 viewport is part of the measurement - a smaller window would
shift the fill-rate-bound results.

## Results

| instances | avg frame ms | min ms | max ms | fps | notes |
|---|---|---|---|---|---|
| 1,002,185 | 16.67 | 16.50 | 16.80 | 60.0 | vsync locked, GPU idle-waiting |
| 5,043,850 | 54.04 | 33.20 | 100.10 | 18.5 | no frame hit 60 |
| 20,000,000 | 552.01 | 16.70 | 2650.80 | 1.8 | thrashing, not uniform overload |

<!-- Screenshots pending - drop the three PNGs into docs/img/ and uncomment the
     matching line below. See docs/img/README.md.

     1M:  ![1,002,185 instances at 60fps](img/stress-1m.png)
     5M:  ![5,043,850 instances at 18.5fps](img/stress-5m.png)
     20M: ![20,000,000 instances at 1.8fps](img/stress-20m.png)
-->

## Findings

**Draw budget is roughly 2M instances at 60fps on this hardware.** 1M is vsync
locked, so the true headroom above 1M was not directly observed - the GPU is
idle-waiting and the measurement only proves it is comfortably inside budget. 5M
costs 3.3x the frame time of 1M, close to linear, which indicates a vertex/fill
rate limit rather than a memory cliff. Extrapolating that slope back to a 16.7ms
frame puts the ceiling near 2M.

**20M is a distinct second failure mode.** A 2650ms max frame alongside a 16.70ms
min is not uniform overload - a uniformly overloaded renderer produces uniformly
slow frames. The spread indicates buffer upload stalls or memory pressure, with
~400MB of instance buffer at that count a likely cause. This was not investigated
further, since 20M is far above the usable budget regardless.

**Consequence for architecture: culling and LOD are not optimisations, they are
the architecture.** Designs of 10-50M placements can never be handed to the GPU
whole. Every frame must draw a filtered subset, and every LOD level must be built
to keep the on-screen total under ~2M. This is a constraint on the data
structures, not a pass to add later.

**At fit-to-die zoom, one million subpixel rectangles average out to uniform grey
noise - zero information conveyed.** Caveat: the synthetic generator is uniformly
random, whereas real layouts have visible structure - memory macros, row density
variation, power grid, routing congestion. The mud is therefore partly a generator
artifact. But the underlying conclusion holds: raw per-cell geometry cannot
produce a useful full-die view. A density raster or merged blocks is required.

## Not yet measured

- **Viewport culling under load.** The decisive open question: does filtering 20M
  to a viewport subset recover 60fps, or does rebuilding and re-uploading the
  instance buffer each frame cost more than it saves? Determines whether the
  design uses one per-frame buffer or persistent per-tile buffers.
- **f32 precision at deep zoom** (local origin fix toggle, unexercised).
- **Subpixel skip threshold behaviour.**
- **Parse throughput on real LEF/DEF.** Untouched by this spike by design.

## Status

Spike complete for throughput. Three of four planned measurements outstanding.
Code is throwaway; the numbers are the artifact.
