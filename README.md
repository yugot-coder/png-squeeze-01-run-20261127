# PNG Squeeze — smallest lossless PNGs for screenshots

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/yugot-coder/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/yugot-coder/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

An entry for the [Squeeze screenshots into the smallest PNG](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) competition on [make.fun](https://make.fun/?ref=za0zfbxx&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127).

## What it does

`main.ts` (Node 22, standard library only) reads the eight 1280×720 RGBA screenshots from
`/input/<id>/image.png` and writes a lossless PNG for each to `/output/<id>/image.png`,
deterministically, in one run:

1. **Best colour form per image** — palette (≤256 colours, transparent entries first),
   grey, grey+alpha, RGB, RGBA, or a single transparent colour keyed by `tRNS`
   instead of an alpha channel. A palette holds a flat screenshot in a third of the
   bytes of RGB, and a grey screenshot's palette form is skipped (same 1 byte a pixel
   plus the PLTE chunk, and grey values keep their ordering for the filters).
2. **Best filter per image** — the five PNG filters are all computed per row, plus a
   per-row fewest-distinct-byte-pairs choice; each candidate is weighed by a real
   zlib stream (level 6) and the smallest wins. Per-row entropy heuristics were
   measured and rejected: on screenshots they destroy the cross-row matches that
   carry the compression.
3. **A zopfli-style deflate, written from scratch** — DP optimal parsing that weighs,
   at every position, the literal, the longest match overall and the longest match
   at a near distance (horizontal runs), plus matches at structural distances
   (byte run, pixel repeat, row repeat) that a hash chain's early exit would miss;
   costs refined per block from the parse's own frequencies; dynamic Huffman blocks
   with package-merge length-limited codes, falling back to fixed Huffman when that
   is smaller. The final stream is the smaller of this deflate and zlib level 9.
   The work budget is fixed by the data, never by the wall clock, so two runs
   write byte-identical files.

## Practice-set result

| instance | theme | bytes | scale | baseline |
|----------|-------|------:|------:|---------:|
| i001 | flat  | 11,562 | 13,547 | 25,099 |
| i002 | rich  | 49,699 | 55,063 | 59,994 |
| i003 | alpha | 101,459 | 107,892 | 107,297 |
| i004 | grey  | 104,468 | 110,521 | 159,860 |
| i005 | flat  | 15,542 | 18,669 | 30,157 |
| i006 | rich  | 173,780 | 185,295 | 203,550 |
| i007 | alpha | 60,156 | 64,285 | 78,176 |
| i008 | grey  | 23,420 | 26,807 | 44,018 |

Practice score **731,539 / 1,000,000** (house baseline fixed-paeth: 420,399), all 8
instances answered, two runs byte-identical, ~28 s for the whole set.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
