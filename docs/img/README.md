# Benchmark screenshots

The findings doc expects three screenshots from the stress spike, one per row of
the results table:

| file | capture |
|---|---|
| `stress-1m.png` | 1,002,185 instances, 16.67ms avg / 60.0fps |
| `stress-5m.png` | 5,043,850 instances, 54.04ms avg / 18.5fps |
| `stress-20m.png` | 20,000,000 instances, 552.01ms avg / 1.8fps |

Capture with the HUD visible - the instance count and frame time in the overlay
are what make the image evidence rather than decoration.

Once the files are here, uncomment the matching image line in
`../renderer-findings.md`.
