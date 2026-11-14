# @ndqp/bun-rusty-mp3

> **Personal test project — not production ready.** This was built for a
> personal need (a fast MP3 encoder for a Bun server) and written with AI
> assistance. It is not hardened, audited, or supported, and its API and
> encoded output may change. For production use, use the battle-tested
> package whose API it mirrors: **[@breezystack/lamejs](https://www.npmjs.com/package/@breezystack/lamejs)**
> (a pure-JavaScript port of LAME).
>
> This project is only the thin binding between the two; the codec and
> the API it mirrors are other people's work, credited below.

Bun/Node bindings to **[rusty_mp3](https://crates.io/crates/rusty_mp3)** —
a complete MP3 (MPEG-1/2/2.5 Layer III) decoder and encoder in pure Rust,
no C, no FFI. Drop-in replacement for `@breezystack/lamejs`:

```js
import { Mp3Encoder } from '@ndqp/bun-rusty-mp3';

// mono, 44.1 kHz, 128 kbps — same calls as lamejs
const mp3encoder = new Mp3Encoder(1, 44100, 128);
const mp3Data = [];
const samples = new Int16Array(44100); // 1 s of PCM — replace with real samples
const sampleBlockSize = 1152; // can be anything, but make it a multiple of 576

for (let i = 0; i < samples.length; i += sampleBlockSize) {
  const mp3buf = mp3encoder.encodeBuffer(samples.subarray(i, i + sampleBlockSize));
  if (mp3buf.length > 0) mp3Data.push(mp3buf);
}
const mp3buf = mp3encoder.flush(); // finish writing mp3
if (mp3buf.length > 0) mp3Data.push(mp3buf);
// mp3Data now holds the complete MP3; e.g. new Blob(mp3Data, { type: 'audio/mp3' })
```

Stereo differs only in construction and the call:
`new Mp3Encoder(2, 44100, 128)` and `encodeBuffer(leftChunk, rightChunk)`.

## Install

```sh
npm install @ndqp/bun-rusty-mp3
# or
bun add @ndqp/bun-rusty-mp3
```

Prebuilt native binaries are shipped for:

| OS | Arch | libc |
| --- | --- | --- |
| macOS | arm64 | — |
| Windows | x64, arm64 | MSVC |
| Linux | x64, arm64 | glibc, musl |

There is **no source-build fallback**: no cargo, no node-gyp, no postinstall
compile. If no prebuilt fits your machine, install fails with
`ERR_BUN_RUSTY_MP3_NO_PREBUILT` naming your platform and the supported
list, instead of failing silently at first use. If your platform is not
listed, please open an issue.

Requires Bun >= 1.3 or Node >= 18.

## API

### `new Mp3Encoder(channels?, sampleRate?, kbps?, options?)`

Same signature as lamejs: `channels` 1 (mono) or 2 (stereo), `sampleRate`
one of 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000 Hz,
`kbps` CBR target bitrate 8–320. All three default like lamejs
(`1, 44100, 128`) when omitted. The bitrate is snapped to the nearest
legal Layer III value for the MPEG version (e.g. 127 → 128; MPEG-2/2.5
tops out at 160 kbps) — see `encoder.bitrateKbps` for the value actually
used.

`options` (extra, all optional):

| Option | Meaning |
| --- | --- |
| `vbr: true` or `vbr: <0-9>` | VBR mode instead of CBR (LAME-style `-q:a` quality index, 0 best … 9 smallest) |
| `vbrQuality: <0-9>` | VBR quality index (default 2 when `vbr: true`) |

One instance = one stream; after `flush()` it is done.

### `encodeBuffer(left, right?) → Buffer`

Encode one chunk of s16 PCM. Mono: `encodeBuffer(left)`; stereo:
`encodeBuffer(left, right)` with both `Int16Array`s the same length
(not interleaved — the interleave happens inside Rust). `Buffer` /
`Uint8Array` holding s16le bytes is also accepted. Returns the MP3 bytes
for that chunk; **may legitimately be empty** while the encoder is
filling a frame — always guard on `.length`, as with lamejs.

> **Streaming note (CBR, MPEG-1, ≤ 256 kbps).** rusty_mp3's reservoir
> mode is on by default at these settings: frames are banked and the
> whole stream is assembled at `flush()`, so `encodeBuffer()` returns
> empty until then. This is the crate's quality-optimal path (it closes
> most of the gap to LAME at low bitrates — see `docs/PERFORMANCE.md`).
> The lamejs collect-then-flush pattern works unchanged. For
> incremental output before `flush()`, use 320 kbps, VBR, or an
> MPEG-2/2.5 sample rate — all three stream frame by frame.

### `flush() → Buffer`

End of input: flush the tail and return every remaining MP3 packet.
Must be called after the last `encodeBuffer()` — skipping it loses the
trailing frames. Idempotent: a second call returns an empty buffer.
Encoding after `flush()` throws.

### Extras (not in lamejs)

- `encodeInterleaved(pcm)` — encode already-interleaved s16le PCM
  (L, R, L, R, …) with no interleave copy.
- `encodeInto(left, right, out)` / `flushInto(out)` — encode into a
  caller-provided output buffer, returning bytes written. No `Buffer`
  is allocated per chunk. `out` must be large enough; the error names
  the bytes needed.
- `new Mp3Decoder()` — decode a whole MP3 slice:
  `decode(mp3)` → `{ sampleRate, channels, samples: Int16Array }`,
  `decodeFloat32(mp3)` → `{ sampleRate, channels, samples: Float32Array }`
  (f32 in [-1, 1], the decoder's native output). Also exported as the
  shorthand `decodeMp3(mp3)`. The decoder is tag-aware (see below).
- `WavHeader.readHeader(dataView)` — parse a RIFF/WAVE header (PCM
  only), for full lamejs compatibility. Returns `undefined` for
  non-WAV / non-PCM input, throws on an extended fmt chunk.
- Constants: `SUPPORTED_SAMPLE_RATES`, `ENCODER_DELAY` (528),
  `DECODER_DELAY` (529), and `samplesPerFrame(sampleRate)` (1152 for
  MPEG-1, 576 for MPEG-2/2.5).

### Gapless / delay

The encoder writes a LAME-style Info/Xing tag frame first, recording
encoder delay **528** and the end padding, so tag-aware players
(ffmpeg included) decode the stream to exactly the input's length.
The bundled `Mp3Decoder` skips the tag frame, so a round trip lines
up at exactly `ENCODER_DELAY + DECODER_DELAY` = **1057** samples:
trim that many samples from the start of the decoded output to recover
the original alignment. (A decoder that is *not* tag-aware will see
one extra frame of silence first, i.e. a 2209-sample shift.)

## Benchmarks

Encode of 10 s of PCM, 44.1 kHz, 128 kbps, median of 3 runs
(`bun bench/bench.mjs`), on this project's VM (Linux x64, shared
1.5 CPU, portable prebuilt — no `target-cpu=native`). Your numbers
will differ; run the bench yourself. Full method and quality numbers
in `docs/PERFORMANCE.md`.

**Bun 1.4.4**

| Case | bun-rusty-mp3 | lamejs | Speedup |
| --- | --- | --- | --- |
| stereo, chirp + noise | 147 ms (68× realtime) | 848 ms (12×) | **5.75×** |
| stereo, sine 440/880 Hz | 129 ms (77×) | 401 ms (25×) | **3.10×** |
| mono, sine 440 Hz | 102 ms (98×) | 208 ms (48×) | **2.04×** |
| decode, 10 s stereo | 22 ms (461× realtime) | — (no decoder) | — |

**Node 24.22.1**

| Case | bun-rusty-mp3 | lamejs | Speedup |
| --- | --- | --- | --- |
| stereo, chirp + noise | 145 ms (69× realtime) | 1098 ms (9×) | **7.59×** |
| stereo, sine 440/880 Hz | 131 ms (76×) | 662 ms (15×) | **5.05×** |
| mono, sine 440 Hz | 105 ms (95×) | 390 ms (26×) | **3.72×** |
| decode, 10 s stereo | 17 ms (600× realtime) | — (no decoder) | — |

Honest caveats, read before quoting these numbers:

- The speedup is **2–8×**, not the 100×+ the crate's "120× realtime"
  figure might suggest — lamejs (pure-JS LAME) is already fast, and
  the comparison is encode-vs-encode on the same machine. The crate's
  120× is an absolute throughput claim (ours measures 68–98× on this
  shared VM); the *relative* speedup over lamejs is what matters here.
- Speedup is smallest on pure tones (lamejs is fastest there) and
  largest on complex signals.
- Quality is close to lamejs, not identical: round-trip RMS error at
  128 kbps is 0.00006 for a 440 Hz sine, 0.062 for white noise
  (lamejs: 0.124 on the same signal). See `docs/PERFORMANCE.md`.

## Tests

43 JS tests + 6 Rust unit tests, run under both Node and Bun:

```sh
npm test        # node --test test/*.test.mjs
npm run test:bun  # bun test test/
npm run typecheck
cargo test      # Rust unit tests (pure helpers + crate-level round trip)
```

They cover: frame-header validity for every frame, round-trip
decode-back (own decoder *and* ffmpeg) with RMS assertions, mono and
stereo (including L/R separation), all nine sample rates, bitrates
64–320 + VBR, silence / DC / full-scale / noise / chirp, empty and
tiny inputs, non-frame-multiple lengths, chunking invariance,
determinism, `encodeInto`/`flushInto`, WavHeader, and invalid inputs.
Tests assert measured thresholds, never silent skips — a missing
native binding fails the run, it does not skip the codec tests.

## How it works

`src/lib.rs` is a thin napi-rs layer over `rusty_mp3` 1.0.6 (exact pin —
the crate states encoder output may change in minor releases, so the
pin is deliberate). Inputs arrive as zero-copy `BufferSlice` views;
mono s16le bytes go straight into `push_pcm_s16le` with no copy.
Stereo lamejs-style input (two separate arrays) is interleaved in Rust
into a reused scratch buffer. Output is drained per call with
`next_packet()`; `encodeInto`/`flushInto` write into caller buffers.
Sync only — no threadsafe functions or async work. See
`docs/DESIGN.md`.

## Credits

- **rusty_mp3** — the codec. By **Mata Network** and the
  **Remade-With-Rust** team (architect: Tim Almond), Apache-2.0,
  <https://github.com/Remade-With-Rust/remade_ffmpeg_rs>. Pure-Rust
  MP3 decoder + encoder, no C/FFI. This binding would not exist
  without it.
- **@breezystack/lamejs** — the API mirrored. Original `lamejs` by
  **Alex Zhukov**, fork maintained by **breezygideon**, LGPL-3.0. A
  pure-JavaScript port of **LAME** (lame.sourceforge.io).
- **napi-rs** — the Node-API bindings framework that makes the native
  layer possible.

## Licence

- This binding: **MIT** (see `LICENSE`).
- The codec it wraps (`rusty_mp3`): **Apache-2.0**.
- The API it mirrors (`@breezystack/lamejs`): **LGPL-3.0**; the LAME
  code it ports is LGPL. MP3's patents expired in 2017, so the format
  itself is royalty-free.
