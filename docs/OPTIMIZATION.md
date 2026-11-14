# Encode performance investigation (2026-11-15)

Question: can `rusty_mp3` 1.0.6 be optimized the way `rusty-opus` was
(binding-side SIMD conversion, decode 33.1 → 28.6 ms)? Short answer:
**no binding-side win is left** — the binding is already ~5% overhead —
but one crate-side win was prototyped and measured, and two more were
identified. All numbers below are median of 5 runs, 10 s PCM, 44.1 kHz,
on this VM (AMD EPYC, AVX2/AVX512, shared 1.5 CPU), portable release
build (`opt-level = 3`, `lto = "fat"`, no `target-cpu=native`).
Harness: `/tmp/mp3prof` (not committed); it uses the crate's own
`encode::prof` stage profiler.

## Where the time goes (stereo chirp/noise, 128 kbps CBR)

| Stage | Share |
| --- | --- |
| quantize (two-loop quantizer) | **65.6%** |
| psychoacoustic (1024-pt FFT + spreading) | 16.7% |
| huffman-emit (bit packing) | 6.9% |
| mdct+alias | 6.8% |
| filterbank | 4.0% |

Granules: 22,272 long, 0 short on this corpus. `finish()` (reservoir
assembly) is 1–3 ms — the reservoir is not a throughput problem.

## SIMD: already working, and worth ~35%

`MP3_ISA=scalar` vs default, same binary, stereo chirp/noise 128k:
**211 ms → 138 ms**. Stage detail: filterbank 852 → 95 ms (AVX, the
only stage with a big SIMD win), quantize 1839 → 1571 ms (small AVX
win on the line kernel), psychoacoustic / MDCT / Huffman **identical**
— those stages are scalar, `MP3_ISA` does not touch them.

`target-cpu=native` vs portable: 121 vs 135 ms (**~10%**), mostly MDCT
auto-vectorization (163 → 110 ms). Not shippable (SIGILL on older
CPUs) — it only sets the ceiling for "free" compiler wins.

Binding overhead: raw crate 138 ms vs our napi binding 147 ms on the
same input — **~5–9 ms (~5%)**. The push path (i16→f32 + sanitize +
deinterleave) is <1% of encode. Nothing left to win in the binding.

## Prototype: incremental Huffman table selection (measured)

**Idea.** The default CBR path (`loops_slack`) runs up to 24 refine
steps per granule; each step changes ONE scalefactor band, then calls
`huff_cost` → `select()`, which rebuilds the whole 256-cell pair
histogram and re-scores all 32 pair tables in all 3 regions. Only the
changed band's region moved. The prototype caches the per-region
tables/costs and re-scores only the region(s) the band overlaps (plus
the count1 quad table if overlapped). Any change to `big_end` or
`region_end` falls back to a full `select()`. Fallback rate measured:
**6.4%**; regions re-scored: 0.54/call on average (high bands often lie
past `big_end`, so no pair region overlaps at all).

**Verification.** A `VERIFY` mode asserted incremental == full `select()`
(side + bits) on every refine step across all 5 bench cases — zero
mismatches. The vendored crate's own test suite passes with the
prototype: 116 + 6 + 1 + 6 tests, 0 failures. The change is
byte-identical by construction, not a heuristic.

**Result (5-round medians, pristine 1.0.6 vs prototype):**

| Case | Baseline | Prototype | Delta |
| --- | --- | --- | --- |
| stereo chirp/noise 128k CBR | 137 ms | 136 ms | ~0% |
| stereo sine 128k CBR | 118 ms | 116 ms | −2% |
| mono sine 128k CBR | 100 ms | 86 ms | **−14%** |
| stereo chirp/noise 320k CBR | 237 ms | 195 ms | **−18%** |
| stereo chirp/noise VBR q2 | 173 ms | 155 ms | **−10%** |

**Why the win is content-dependent:** it scales with refine
steps/granule — 6.9 at 128k stereo, 7.5 stereo sine, **23.2** mono sine
(near the 24 cap), **16.6** at 320k, 10.8 VBR. At the default 128k
stereo setting the loop breaks early (tight budget) and the win is
~0%. The remaining cost there is the `inner_gain` binary search: 8
full quantize + Huffman-select probes per granule, unoptimized.

Prototype lives only in `/tmp/mp3vendored` (vendored 1.0.6 + the
patch). It is NOT in this repo: shipping it means vendoring the crate
(`[patch.crates-io]`), a fork that diverges from an upstream shipping
~2 versions/day. Not done without a decision (see below).

## Other candidates (identified, not prototyped)

- **FFT SIMD twin** (psychoacoustic, 17%): vectorize the butterfly
  stages in `encode/fft.rs`. Est. **5–10% total**. Medium effort;
  bit-identicalness must be pinned like the existing SIMD twins
  (separate mul+add, never FMA — AVX2/FMA are deliberately unused
  crate-wide).
- **MDCT transpose + SIMD twin** (7%): `cos36` is laid out `[n][k]`
  but the inner loop fixes `k` and iterates `n` — 72-byte strides, one
  cache line per 4 bytes used. Transpose to `[k][n]` (byte-identical,
  near-zero risk) + AVX twin. Est. **3–6% total**. The transpose alone
  is the cheapest item on this list.
- **Warm-start `inner_gain`** (~10% at 128k, unproven): the gain
  changes slowly granule-to-granule; bracket the binary search around
  the previous granule's gain (±16 → 5 probes instead of 8), expanding
  the bracket until it provably contains the minimum. Byte-identical
  *if* the bracket logic is verified — an unverified heuristic start
  would change output bits and needs PEAQ re-validation.
- **Buffered `BitWriter`** (emit, 7%): replace the per-bit loop with a
  u64 accumulator flushing whole bytes. Est. 1–3%, trivially
  byte-identical.
- **Not worth it:** push path (<1%), reservoir flush copies (once per
  stream), `prof::time` clock reads (~0.1%), f32 conversion of the
  quantizer (deliberate f64 bit-exactness choice), parallelizing Huffman
  emit / the rate loop (inherently serial).

## Verdict

- The opus-style binding win does not exist here: the binding is
  already zero-copy and the codec dominates.
- Incremental Huffman selection is proven and byte-identical, but
  **~0% at the default 128k stereo setting** — not worth a fork on its
  own. It pays 10–18% at 320k / VBR / loose-budget content.
- The next real wins (FFT SIMD, MDCT transpose, warm-start gain) all
  live inside the crate and need either a vendored fork or upstream
  contributions. Upstream is extremely active (18 versions in 8 days,
  Nov 2026) and performance-obsessed — these are the kind of patches
  they may land themselves in 1.0.7+.
