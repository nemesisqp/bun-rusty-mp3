# Changelog

## 0.1.0 — 2026-11-15

First release (code complete; npm publish pending the owner's token).

- **Mp3Encoder** — drop-in replacement for `@breezystack/lamejs`
  1.2.7: `new Mp3Encoder(channels, sampleRate, kbps)`,
  `encodeBuffer(left, right?)`, `flush()`. Backed by `rusty_mp3`
  1.0.6 (exact pin), pure Rust, no C/FFI.
- **Mp3Decoder** — whole-slice decode (`decode` → `Int16Array`,
  `decodeFloat32` → `Float32Array`), tag-aware: skips the leading
  Xing/Info frame so round trips align at the 1057-sample codec delay.
- **WavHeader** — `readHeader(DataView)` / `toBuffer()`, for full
  lamejs compatibility.
- Extras: VBR mode (`{ vbr }` / `{ vbrQuality }`), `encodeInterleaved`,
  `encodeInto` / `flushInto` (zero-alloc), snapped-bitrate reporting.
- 43 JS tests + 6 Rust unit tests (Node + Bun), ffmpeg interop tests,
  honest benchmarks in `README.md` / `docs/PERFORMANCE.md`:
  **2–8× faster than lamejs** to encode (Bun 1.4.4 / Node 24),
  461–600× realtime to decode.
- Prebuilt binaries for 7 targets (macOS arm64, Windows x64/arm64,
  Linux x64/arm64 glibc + musl); no source-build fallback
  (`ERR_BUN_RUSTY_MP3_NO_PREBUILT`).
- Known behaviour, documented not hidden: CBR MPEG-1 at ≤ 256 kbps
  uses rusty_mp3's reservoir mode, so `encodeBuffer()` returns empty
  until `flush()` (see `docs/DESIGN.md`).
