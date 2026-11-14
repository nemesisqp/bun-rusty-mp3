# Design

How `bun-rusty-mp3` is built, and what it borrows (and deliberately does
not borrow) from `bun-rusty-opus`.

## Layering

```
JS caller (lamejs API)
  └─ lib/wrapper.js    — defaults, validation, lamejs surface, WavHeader
  └─ lib/loader.js     — prebuilt loading, ERR_BUN_RUSTY_MP3_NO_PREBUILT
  └─ binding.js        — napi-rs generated loader (do not hand-edit)
  └─ src/lib.rs        — thin napi layer over rusty_mp3
  └─ rusty_mp3 1.0.6   — pure-Rust MP3 codec (exact pin)
```

The JS wrapper owns all defaults, validation and the public surface;
the native layer takes only primitives and small objects, so the N-API
surface stays small and fast. Construction is a free napi function
(`create_mp3`) rather than a class constructor, so construction errors
surface as JS exceptions.

## Zero-copy, and where the copy is unavoidable

- **Mono:** the caller's `Int16Array` bytes go straight into
  `push_pcm_s16le` — no copy at all. A `Buffer`/`Uint8Array` of s16le
  bytes is the same path.
- **Stereo (lamejs shape):** lamejs takes two separate arrays
  (`left`, `right`). `rusty_mp3` takes interleaved PCM only, so the
  interleave copy is unavoidable — but it happens in Rust, into a
  scratch buffer that lives on the encoder and only grows, never in JS.
- **Already-interleaved input:** `encodeInterleaved(pcm)` skips the
  interleave entirely (native `right = None` means "already
  interleaved" for stereo).
- **Output:** `encode()` / `flush()` return a fresh `Buffer` per call
  (the common path). `encodeInto()` / `flushInto()` write into a
  caller-provided buffer — no allocation per chunk.
- **Sync only.** No threadsafe functions, no async work, no borrowed
  slice ever crosses a thread hop. (Bun's N-API had crashes with async
  surfaces in the past; the encoder is CPU-bound at 68–98× realtime,
  so JS can put it in a `Worker` if it wants parallelism.)

## The reservoir finding (read this before "fixing" streaming)

`rusty_mp3` 1.0.6 has a **3R1 reservoir-RD mode, default ON for CBR
MPEG-1 at ≤ 256 kbps**: frames are encoded during `push`, banked in
the encoder state, and assembled into the bit-reservoir stream only at
`finish()`. Consequences, all verified live (see `test/mp3.test.mjs`,
"reservoir mode"):

- `encodeBuffer()` returns **empty** until `flush()` at the most common
  settings (128 kbps / 44.1 kHz CBR). The lamejs collect-then-flush
  pattern works unchanged; anyone expecting incremental output before
  `flush()` will see nothing.
- At 320 kbps, in VBR mode, and at MPEG-2/2.5 sample rates, the fixed
  path is used and output streams frame by frame.
- Memory grows with the stream: the banked frames are roughly the
  output size (a 10-minute 128 kbps clip banks ~9.6 MB). Fine for
  clips; a consideration for very long streams.
- The payoff is quality: the crate's own PEAQ measurements put the
  reservoir path within ~0.3 ODG of LAME at 128 kbps, vs ~0.6–1.0 ODG
  behind without it. That is why the binding keeps the crate default
  instead of forcing `MP3_RESERVOIR=0` (the env var is the crate's only
  switch — there is no per-encoder config for it).

If a future version needs true streaming at 128 kbps CBR, the options
are: accept the quality cost and set `MP3_RESERVOIR=0` in the process
environment before the first encoder is created, or ask upstream for a
config flag. Either change must re-run the whole test suite and the
bench, because it changes encoded bytes.

## The Xing tag and the decoder's 1057-sample alignment

The encoder leads every stream with a LAME-style Info/Xing tag frame
(encoder delay 528, decoder delay 529). `rusty_mp3`'s own decoder
decodes that frame as a full frame of silence, so a naive round trip is
shifted by 1152 (tag frame) + 1057 (codec delay) = 2209 samples.
This binding's `Mp3Decoder` is **tag-aware**: `decode_all` scans the
first frame, and if it carries a `Xing`/`Info` tag (checked at the
correct offset for the version/channel mode, via the crate's public
`FrameHeader::parse` / `frame_size` / `side_info_len`), it drops that
frame before pushing. A round trip then lines up at exactly 1057
samples — verified by the decoder tests (sine RMS error 0.00006 at lag
1057). Any parse doubt falls back to not skipping (the tag decodes as
silence, as before). Streams without a tag (e.g. lamejs output) are
untouched; their lag is the other encoder's delay + 529 (LAME: 1105,
verified in the interop tests).

## Error model

`rusty_mp3` follows FFmpeg's drain protocol: `next_packet()` /
`next_frame()` return `Err(Again)` (feed more input) or `Err(Eof)`
(flushed and drained). Neither is a failure — the binding treats both
as "end of drain" internally and never surfaces them to JS. Real
errors (`Unsupported` for a bad sample rate on first push,
`InvalidData`) become JS exceptions with the crate's message.

## Lessons carried over from bun-rusty-opus

- **Pin the codec exact** (`=1.0.6`) after verifying the API against
  that version, and document why (encoder bytes may change in minor
  releases — the crate's own README says so).
- **Never `-C target-cpu=native` in shipped builds.** The codec
  runtime-dispatches SIMD (AVX/NEON); `native` is only for
  `scripts/build-local.sh`.
- **No source-build fallback, anywhere.** The loader throws with the
  package's own error code; `postinstall` fails the install on an
  unsupported platform instead of failing at first use.
- **Platform packages as lockstep `optionalDependencies`**, generated
  in CI by `napi create-npm-dirs` / `napi prepublish`; never commit
  `npm/*`.
- **Scoped package name** (`@ndqp/...`): unscoped platform packages
  hit npm spam detection in the opus project.
- **Tests must fail loudly, never silently skip.** A missing binding
  fails the run; a stale test that probes for a removed dependency
  (the opus v2.13 lesson) is not repeated here.
- **Honest numbers over headline numbers.** The crate claims ~120×
  realtime encode; we report the measured 68–98× on this VM and the
  2–8× speedup over lamejs, with method, in `docs/PERFORMANCE.md`.

## Lessons that did NOT carry over

- **napi feature: `napi8`, not `napi9`.** Opus used `napi9`; for mp3
  the safe default is `napi8` (Bun's N-API version is 10, Node's
  default is 8 — `napi8` is the widest-compatible subset, and nothing
  here needs napi9 APIs).
- **Rust unit tests must not touch napi types.** A cdylib's test
  binary has no Node runtime to resolve the `napi_*` symbols, so the
  link fails with undefined `napi_reference_unref` etc. Rust tests
  cover only pure helpers and the crate directly; the napi surface is
  covered by the JS tests. (Opus hit the same wall — its Rust tests
  only cover pure helpers.)
- **`Option<f64>` in a napi object takes `undefined` for `None` — not
  `null`.** Passing `null` throws "Failed to convert napi value Null
  into rust type `f64`". Caught by the first smoke test.
- **MPEG-2/2.5 frame size uses coefficient 72, not 144** (576 samples
  per frame). The test helper originally used 144 for all versions
  and overran the parse — caught by the all-rates test.
