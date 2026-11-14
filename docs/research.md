# Research notes (checked 2026-11-15)

What was verified before building, and where Gemini's note (quoted in
the brief) was right, overstated, or wrong. Sources are the live pages
and the vendored crate source, not memory.

## rusty_mp3 — the codec

- **Latest: 1.0.6** (published 2026-11-13), `rusty_mp3 = "1"`,
  MSRV 1.85. Licence **Apache-2.0**. Authors field in Cargo.toml:
  **Mata Network**; README credits "Architect: Tim Almond", part of
  **Remade With Rust**; repo
  <https://github.com/Remade-With-Rust/remade_ffmpeg_rs>.
- **It is an encoder AND a decoder** — the brief's premise ("use
  rusty_mp3") is sound. Pure Rust, no C/FFI, zero runtime deps.
  Encoding: CBR 8–320 kbps + VBR, mono/stereo/joint stereo,
  psychoacoustic model, transient block switching, per-band noise
  shaping, bit reservoir, gapless LAME-style Info/Xing tags. Decoder
  passes all 16 ISO 11172-4 / 13818-4 Layer III conformance vectors.
- **API (verified against the vendored 1.0.6 source, not just docs):**
  `Mp3EncoderConfig { bitrate_kbps: u32, vbr_quality: Option<f32> }`,
  `Mp3Encoder::new(config)`,
  `push_pcm_f32 / push_pcm_s16 / push_pcm_f32le / push_pcm_s16le`
  (interleaved, `channels: u16, sample_rate: u32` on every push —
  the first push fixes the header), `next_packet() -> Result<Vec<u8>>`
  (`Again`/`Eof` drain protocol), `finish()` (idempotent).
  `Mp3Decoder::new()`, `push(&[u8])`, `next_frame() ->
  Result<DecodedAudio>`, `flush()`; `DecodedAudio { sample_rate,
  channels, samples: Vec<f32> }` — **interleaved f32 in [-1, 1], not
  i16** (an early web summary said i16; the source says f32).
  `vbr_quality_index(q: f32) -> f32` maps LAME-style `-q:a` 0–9 to the
  target-average-bitrate `vbr_quality` expects. `snap_bitrate` snaps
  to the nearest legal value. Frame: 1152 samples/channel (MPEG-1),
  576 (MPEG-2/2.5). Sample rates: the nine MPEG rates only.
  Encoder delay 528, decoder delay 529
  (`encode::lametag::ENCODER_DELAY / DECODER_DELAY`).
- **Maturity caveat:** very young (1.0.0 on 2026-11-11, 1.0.6 two days
  later). README: 1.x API is stable, decoder output is bit-exact /
  stable, **encoder output may change in minor releases** when quality
  improves — hence the exact `=1.0.6` pin.
- **Quality vs LAME (crate's PEAQ, ODG diff, + = LAME better):**
  +0.304 @96k, +0.225 @128k, +0.091 @160k, +0.084 @192k.
- **Speed (crate's claim, 1 desktop x86-64 core):** encode ~120×
  realtime, decode ~830×. Measured here (shared VM, portable build):
  encode 68–98×, decode 461–600× — see `docs/PERFORMANCE.md`.
- **Alternatives considered (fallbacks only, not needed):**
  `mp3lame-encoder` 0.2.5 (LAME via C/FFI, LGPL — best quality,
  worst for prebuilds), `shine-rs` 0.1.5 (pure Rust, older/simpler),
  `audio2mp3-core` (CBR only), `threers-codec` 0.0.12 (very early),
  `minimp3` / `symphonia` (decoder-only for MP3).

Sources: <https://crates.io/crates/rusty_mp3>,
<https://docs.rs/crate/rusty_mp3/latest>, vendored source in
`~/.cargo/registry/src/*/rusty_mp3-1.0.6/src/lib.rs`.

## @breezystack/lamejs — the API mirrored

- **Latest: 1.2.7** (2023-10-17; 1.2.1–1.2.6 deprecated as buggy).
  Licence **LGPL-3.0**. Original author **Alex Zhukov**; fork
  maintained by **breezygideon** (`shjy90@gmail.com`), source
  `github.com/gideonstele/lamejs` (fork of `zhuker/lamejs`).
  Pure-JS LAME port, zero runtime deps.
- **Exact API** (`type.d.ts`):
  `new Mp3Encoder(channels, sampleRate, kbps)`,
  `encodeBuffer(left: Int16Array, right?: Int16Array): Uint8Array`
  (runtime returns `Int8Array`), `flush(): Uint8Array`, plus
  `WavHeader` (`readHeader(DataView): WavHeader | undefined`,
  `toBuffer()`). No other exports.
- **Behaviour:** frame 1152 samples; `encodeBuffer` accepts arbitrary
  lengths but may return empty (encoder buffering); `flush()` is
  required (skipping it loses up to 1151 samples); mono sets
  `right = left`; stereo requires equal lengths (assertion throws);
  fixed config: mode STEREO, LAME quality 3, CBR, no VBR tag, no ID3.
  No reset/reuse — one instance = one stream.

Sources: <https://registry.npmjs.org/@breezystack/lamejs>,
<https://github.com/zhuker/lamejs>, <https://github.com/gideonstele/lamejs>.

## napi-rs + Bun — verdict on Gemini's note

Gemini's note ("Node-API is the most stable way to run native code in
Bun production; use napi-rs; pass `Int16Array` as `&[i16]` zero-copy")
is **direction-correct, wording overstated**:

- Bun's docs do *not* say Node-API is "the most stable way for
  production" — they say Bun implements Node-API from scratch and
  "most existing Node-API extensions work with Bun out of the box".
  The "stable ABI" claim is Node.js's, not Bun's. napi-rs is still
  the right choice (vs `bun:ffi`/koffi/WASM) for max-speed Bun server
  use — but it is **not** "guaranteed stable on Bun": test on the
  exact Bun patch you ship (better-sqlite3 crashed Bun 1.4.0, loaded
  on 1.4.4).
- **Versions (Nov 2026):** `napi` 3.16.x, `napi-derive` 3.7.x,
  `napi-build` 2, `@napi-rs/cli` 3.10.x, Bun 1.4.4. CLI v3 ↔ `napi`
  v3 only. This project uses `napi` 3 with feature `napi8` (the safe
  default for max Node+Bun compat; Bun's N-API version is 10, Node's
  default is 8).
- **Zero-copy mapping confirmed:** `&[i16]` maps to `Int16Array`,
  `BufferSlice` is a borrowed zero-copy view, `Vec<u8>.into() ->
  Buffer` transfers the allocation with no copy. But:
  - **Alignment:** an `Int16Array` needs `byteOffset % 2 == 0`; a
    Node `Buffer` from the shared pool can have an odd offset. This
    binding takes `BufferSlice` (`&[u8]`) and decodes s16le in Rust,
    sidestepping the alignment trap entirely.
  - **Stereo:** `rusty_mp3` takes interleaved PCM only — there is no
    separate L/R entry point, so the interleave copy is unavoidable
    for lamejs-shaped input (done in Rust, into a reused scratch).
  - **No borrowed slice across threads/async**; this binding is sync
    only.
  - **External buffers** (`napi_create_external_buffer`) cannot be
    transferred across `Worker`s since Bun PR #39973 — copy or
    re-encode instead.

Sources: <https://bun.sh/docs/runtime/node-api>,
<https://napi.rs/docs/concepts/typed-array>,
<https://napi.rs/docs/introduction/getting-started>,
<https://github.com/napi-rs/website/blob/HEAD/content/docs/more/v2-v3-migration-guide.en.mdx>.
