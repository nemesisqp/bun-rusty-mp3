/**
 * @ndqp/bun-rusty-mp3 — Bun/Node bindings to rusty_mp3 (pure-Rust MP3 codec).
 *
 * `Mp3Encoder` mirrors @breezystack/lamejs: one class, `new
 * Mp3Encoder(channels, sampleRate, kbps)`, `encodeBuffer(left, right?)`
 * on Int16Array PCM, `flush()` at the end. See README.md for the full API.
 *
 * NOTE: this is the hand-written public type definition. The napi-rs
 * generated types for the raw native binding live in lib/binding.d.ts.
 */

export interface Mp3EncoderOptions {
  /**
   * VBR mode. `true` uses quality index 2; a number 0 (best) .. 9
   * (smallest) is a LAME-style `-q:a` index. Omit (default) for CBR.
   */
  vbr?: boolean | number;
  /** VBR quality index 0 (best) .. 9 (smallest). Default 2 when `vbr: true`. */
  vbrQuality?: number;
}

export interface DecodedMp3 {
  sampleRate: number;
  channels: number;
  /** Interleaved s16 PCM. Trim the first ENCODER_DELAY + DECODER_DELAY (1057) samples to recover the original alignment. */
  samples: Int16Array;
}

export interface DecodedMp3Float32 {
  sampleRate: number;
  channels: number;
  /** Interleaved f32 PCM in [-1, 1]. Trim the first ENCODER_DELAY + DECODER_DELAY (1057) samples to recover the original alignment. */
  samples: Float32Array;
}

/**
 * @breezystack/lamejs-compatible MP3 encoder.
 *
 * ```ts
 * import { Mp3Encoder } from '@ndqp/bun-rusty-mp3';
 * const encoder = new Mp3Encoder(2, 44100, 128);
 * const mp3Data: Uint8Array[] = [];
 * for (let i = 0; i < left.length; i += 1152) {
 *   const buf = encoder.encodeBuffer(left.subarray(i, i + 1152), right.subarray(i, i + 1152));
 *   if (buf.length > 0) mp3Data.push(buf);
 * }
 * const tail = encoder.flush();
 * if (tail.length > 0) mp3Data.push(tail);
 * ```
 *
 * One instance = one stream; after `flush()` it is done.
 */
export declare class Mp3Encoder {
  constructor(channels?: number, sampleRate?: number, kbps?: number, options?: Mp3EncoderOptions);
  readonly channels: number;
  readonly sampleRate: number;
  /** Bitrate actually used, after snapping to the nearest legal Layer III value. */
  readonly bitrateKbps: number;
  /** Samples per MP3 frame for this stream (1152 MPEG-1, 576 MPEG-2/2.5). */
  readonly samplesPerFrame: number;
  /** Encoder delay in samples per channel (528). */
  readonly encoderDelay: number;
  /** Decoder delay in samples per channel (529). */
  readonly decoderDelay: number;
  readonly finished: boolean;

  /**
   * Encode one chunk of PCM -> MP3 bytes for that chunk. May return an
   * empty buffer while the encoder fills its first frame — always guard
   * on `.length`. Mono: `encodeBuffer(left)`; stereo:
   * `encodeBuffer(left, right)` with both arrays the same length.
   */
  encodeBuffer(left: Int16Array | Buffer | Uint8Array, right?: Int16Array | Buffer | Uint8Array): Buffer;
  /**
   * Encode already-interleaved s16le PCM (L, R, L, R, ...) -> MP3 bytes.
   * The fast path when the caller already has interleaved data: no
   * interleave copy. Length must be a multiple of `channels`.
   */
  encodeInterleaved(pcm: Int16Array | Buffer | Uint8Array): Buffer;
  /**
   * Encode into a caller-provided output buffer. Returns bytes written.
   * No `Buffer` is allocated per chunk.
   */
  encodeInto(left: Int16Array | Buffer | Uint8Array, right: Int16Array | Buffer | Uint8Array | null, out: Buffer | Uint8Array): number;
  /**
   * End of input: flush the tail and return every remaining MP3 packet.
   * Must be called after the last `encodeBuffer()`. Idempotent: a
   * second call returns an empty buffer.
   */
  flush(): Buffer;
  /** `flush()` into a caller-provided output buffer. Returns bytes written. */
  flushInto(out: Buffer | Uint8Array): number;
}

/**
 * MP3 decoder — the round-trip / verification counterpart to
 * `Mp3Encoder`. Decodes a whole MP3 byte slice in one call.
 */
export declare class Mp3Decoder {
  /** Decode a whole MP3 slice -> `{ sampleRate, channels, samples: Int16Array }`. */
  decode(mp3: Buffer | Uint8Array): DecodedMp3;
  /** Decode a whole MP3 slice -> `{ sampleRate, channels, samples: Float32Array }` in [-1, 1]. */
  decodeFloat32(mp3: Buffer | Uint8Array): DecodedMp3Float32;
}

/** Decode a whole MP3 slice — shorthand for `new Mp3Decoder().decode(mp3)`. */
export declare function decodeMp3(mp3: Buffer | Uint8Array): DecodedMp3;

/**
 * WAV header helper, for full @breezystack/lamejs compatibility.
 * Parses a RIFF/WAVE header so PCM can be pulled out of a WAV file.
 */
export declare class WavHeader {
  constructor();
  RIFF: number;
  WAVE: number;
  fmt_: number;
  data: number;
  dataOffset: number;
  dataLen: number;
  channels: number;
  sampleRate: number;
  /**
   * Parse a WAV header from a `DataView`. Returns a `WavHeader`, or
   * `undefined` when the data is not a RIFF/WAVE file or is not PCM.
   * Throws on an extended fmt chunk (size other than 16 or 18).
   */
  static readHeader(dataView: DataView): WavHeader | undefined;
  /** Serialise this header as a 44-byte WAV header `ArrayBuffer`. */
  toBuffer(): ArrayBuffer;
}

export declare const SUPPORTED_SAMPLE_RATES: readonly [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
/** Encoder delay in samples per channel (528). */
export declare const ENCODER_DELAY: 528;
/** Decoder delay in samples per channel (529). */
export declare const DECODER_DELAY: 529;

/** Samples per MP3 frame for a sample rate (1152 MPEG-1, 576 MPEG-2/2.5). */
export declare function samplesPerFrame(sampleRate: number): number;
