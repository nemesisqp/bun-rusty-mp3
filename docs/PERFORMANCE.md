# Performance

Measured numbers for `bun-rusty-mp3` v0.1.0. Nothing here is a claim
from a README — every number below was measured on this machine with
`bench/bench.mjs` (encode) or the test suite (quality). Re-run them
yourself: `bun bench/bench.mjs`, `node bench/bench.mjs`, `npm test`.

## Method

- **Machine:** this project's Linux x64 VM, shared 1.5 CPU, 6 GB RAM.
- **Build:** portable prebuilt (`npm run build` — `opt-level = 3`,
  `lto = "fat"`, no `target-cpu=native`). rusty_mp3 runtime-dispatches
  AVX/NEON itself.
- **Input:** 10 s of PCM, 44.1 kHz, 128 kbps CBR, encoded in
  1152-sample blocks via `encodeBuffer()` + `flush()` (the lamejs
  usage pattern), median of 3 runs. The same loop drives lamejs.
- **Runtimes:** Bun 1.4.4 and Node 24.22.1, both on the same VM.

## Encode speed vs @breezystack/lamejs 1.2.7

### Bun 1.4.4

| Case | bun-rusty-mp3 | lamejs | Speedup |
| --- | --- | --- | --- |
| stereo, chirp + noise | 147 ms (68× realtime) | 848 ms (12×) | 5.75× |
| stereo, sine 440/880 Hz | 129 ms (77×) | 401 ms (25×) | 3.10× |
| mono, sine 440 Hz | 102 ms (98×) | 208 ms (48×) | 2.04× |

### Node 24.22.1

| Case | bun-rusty-mp3 | lamejs | Speedup |
| --- | --- | --- | --- |
| stereo, chirp + noise | 145 ms (69× realtime) | 1098 ms (9×) | 7.59× |
| stereo, sine 440/880 Hz | 131 ms (76×) | 662 ms (15×) | 5.05× |
| mono, sine 440 Hz | 105 ms (95×) | 390 ms (26×) | 3.72× |

### Decode speed (ours only — lamejs has no decoder)

| Case | Bun | Node |
| --- | --- | --- |
| decode 10 s stereo | 22 ms (461× realtime) | 17 ms (600× realtime) |

## What the numbers mean (and don't mean)

- **Speedup is 2–8×, not 100×.** lamejs is a well-optimised pure-JS
  LAME port and is already fast — fastest on pure tones (2–3.7×),
  slowest on complex signals (5.8–7.6×). The crate's "120× realtime"
  is an absolute throughput claim; ours measures 68–98× on this
  shared VM, in the same ballpark. The *relative* speedup over lamejs
  is the number that matters for a drop-in replacement, and it is
  2–8×.
- **Output sizes match:** 10 s stereo 128 kbps is 160,545 bytes
  (ours) vs 160,496 bytes (lamejs) — the difference is the Xing tag
  frame and padding, not a bitrate difference.
- **Reservoir mode costs nothing measurable here:** the 128 kbps CBR
  runs above use the reservoir path (frames banked until `flush()`),
  and still hit 68–98× realtime including the flush assembly.

## Quality (round-trip RMS error vs the original, 44.1 kHz, 128 kbps)

RMS error is computed sample-by-sample after trimming the codec
delay (1057 samples for our decoder; 1105 for lamejs output, which
has no Xing tag). Full scale = 1.0.

| Signal | bun-rusty-mp3 | lamejs | Notes |
| --- | --- | --- | --- |
| sine 440 Hz, mono | **0.00006** | — | essentially transparent |
| sine 440/880 Hz, stereo | 0.0002 / 0.0002 | 0.0194 (left) | ours is cleaner on tones |
| chirp 100 Hz–10 kHz, mono, 192 kbps | < 0.03 | — | |
| white noise, mono | **0.062** | 0.124 | noise is the hardest MP3 signal |
| white noise, stereo (one channel) | 0.171 | 0.176 | = mono noise at 64 kbps (0.173) — a per-channel-bitrate effect, not a stereo bug |
| white noise, stereo, 256 kbps | 0.062 | — | 128 kbps/channel restores mono quality |

External validation: ffmpeg 8.1.2 decodes our MP3 to the original PCM
(gapless trim applied by ffmpeg from the Xing tag) with RMS error
< 0.01 for tones and 0.062 for noise; `ffprobe` reports
`mp3, 44100 Hz, 2 channels, ~1.0 s` as expected. The interop tests in
`test/interop.test.mjs` assert all of this.

## Quality vs the crate's own claims

rusty_mp3's README reports PEAQ ODG differences vs LAME of +0.304
@96k, +0.225 @128k, +0.091 @160k, +0.084 @192k (positive = LAME
better) — measurably behind LAME at low bitrates, within ~0.1 ODG at
≥ 160 kbps. Our RMS numbers are consistent with that: tones are
transparent, noise (the worst case) is about 2× closer than lamejs
at 128 kbps, and the gap closes with bitrate. We did not run PEAQ
ourselves; the RMS figures above are the measured substitute.
