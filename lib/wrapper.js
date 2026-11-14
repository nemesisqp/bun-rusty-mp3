'use strict';

/**
 * JS wrapper — the @breezystack/lamejs-compatible surface over the native
 * rusty_mp3 binding.
 *
 * `Mp3Encoder` mirrors lamejs exactly (`new Mp3Encoder(channels,
 * sampleRate, kbps)`, `encodeBuffer(left, right?)`, `flush()`), so it is
 * a drop-in replacement for code written against @breezystack/lamejs.
 * Extra rusty_mp3 features are additive: an `options` argument on the
 * constructor (VBR), `encodeInto` / `flushInto` (zero-alloc reuse),
 * `encodeInterleaved` (already-interleaved PCM, no interleave copy),
 * `Mp3Decoder` (round-trip / verification), and `WavHeader`.
 *
 * All PCM here is signed 16-bit little-endian, exactly like lamejs:
 * mono is one `Int16Array`, stereo is two separate `Int16Array`s of
 * equal length (`left`, `right`) — NOT interleaved. The interleave
 * happens inside Rust.
 */

const { loadNative } = require('./loader');

const native = loadNative();
const { createMp3, decodeAll, encoderDelay, decoderDelay, samplesPerFrame: nativeSamplesPerFrame } = native;

const SUPPORTED_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const ENCODER_DELAY = encoderDelay();
const DECODER_DELAY = decoderDelay();

function samplesPerFrame(sampleRate) {
  return nativeSamplesPerFrame(sampleRate);
}

function assertChannels(channels) {
  if (channels !== 1 && channels !== 2) {
    throw new RangeError(`unsupported channel count ${channels}: Mp3Encoder supports only 1 (mono) or 2 (stereo)`);
  }
}

function assertSampleRate(sampleRate) {
  if (!SUPPORTED_SAMPLE_RATES.includes(sampleRate)) {
    throw new RangeError(
      `unsupported sample rate ${sampleRate}: MP3 supports only ${SUPPORTED_SAMPLE_RATES.join(', ')} Hz`,
    );
  }
}

function assertKbps(kbps) {
  if (!Number.isFinite(kbps) || kbps < 8 || kbps > 320) {
    throw new RangeError(`unsupported bitrate ${kbps}: MP3 CBR supports 8-320 kbps`);
  }
}

/**
 * Coerce an `Int16Array` / `Buffer` / `Uint8Array` to the raw s16le
 * bytes the native layer takes. `Int16Array` shares its backing store
 * (no copy); a `Uint8Array`/`Buffer` is already bytes. Anything else
 * (plain arrays, `Float32Array`) is a type error — lamejs takes
 * `Int16Array` only.
 */
function toS16Bytes(view, name) {
  if (Buffer.isBuffer(view)) return view;
  if (view instanceof Int16Array || view instanceof Uint8Array) {
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new TypeError(`${name} must be an Int16Array (or a Buffer/Uint8Array of s16le bytes)`);
}

function toOutputBuffer(view, name) {
  if (Buffer.isBuffer(view)) return view;
  if (view instanceof Uint8Array) {
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new TypeError(`${name} must be a Buffer or Uint8Array`);
}

/**
 * @breezystack/lamejs-compatible MP3 encoder.
 *
 * ```js
 * const { Mp3Encoder } = require('@ndqp/bun-rusty-mp3');
 * const encoder = new Mp3Encoder(2, 44100, 128);
 * const mp3Data = [];
 * for (let i = 0; i < left.length; i += 1152) {
 *   const buf = encoder.encodeBuffer(left.subarray(i, i + 1152), right.subarray(i, i + 1152));
 *   if (buf.length > 0) mp3Data.push(buf);
 * }
 * const tail = encoder.flush();
 * if (tail.length > 0) mp3Data.push(tail);
 * ```
 *
 * One instance = one stream; after `flush()` it is done. `encodeBuffer`
 * may legitimately return an empty buffer while the encoder is filling
 * its first frame — always guard on `.length`, as with lamejs.
 */
class Mp3Encoder {
  /**
   * @param {number} [channels=1] 1 (mono) or 2 (stereo).
   * @param {number} [sampleRate=44100] one of the nine MPEG rates.
   * @param {number} [kbps=128] CBR target bitrate, 8-320. Snapped to the
   *   nearest legal Layer III value for the MPEG version (e.g. 127 -> 128).
   * @param {object} [options] extra options (all optional):
   *   `vbr` (boolean, or a quality index 0-9) / `vbrQuality` (0 best .. 9
   *   smallest, default 2 when `vbr: true`) — VBR mode instead of CBR.
   */
  constructor(channels = 1, sampleRate = 44100, kbps = 128, options = {}) {
    assertChannels(channels);
    assertSampleRate(sampleRate);
    assertKbps(kbps);
    let vbrQualityIndex;
    if (options && typeof options === 'object') {
      if (options.vbrQuality !== undefined && options.vbrQuality !== null) {
        vbrQualityIndex = options.vbrQuality;
      } else if (options.vbr === true) {
        vbrQualityIndex = 2;
      } else if (typeof options.vbr === 'number') {
        vbrQualityIndex = options.vbr;
      }
      if (vbrQualityIndex !== undefined && (!Number.isFinite(vbrQualityIndex) || vbrQualityIndex < 0 || vbrQualityIndex > 9)) {
        throw new RangeError(`vbr quality index must be 0 (best) to 9 (smallest), got ${vbrQualityIndex}`);
      }
    }
    // NOTE: napi `Option<f64>` in an object takes `undefined` for None —
    // `null` throws "Failed to convert napi value Null into rust type f64".
    this._native = createMp3({
      channels, sampleRate, bitrateKbps: kbps, vbrQualityIndex,
    });
    this._channels = channels;
    this._sampleRate = sampleRate;
  }

  get channels() { return this._channels; }
  get sampleRate() { return this._sampleRate; }
  /** Bitrate actually used, after snapping to the nearest legal value. */
  get bitrateKbps() { return this._native.bitrateKbps(); }
  /** Samples per MP3 frame for this stream (1152 MPEG-1, 576 MPEG-2/2.5). */
  get samplesPerFrame() { return this._native.samplesPerFrame(); }
  /** Encoder delay in samples per channel (528). */
  get encoderDelay() { return ENCODER_DELAY; }
  /** Decoder delay in samples per channel (529). */
  get decoderDelay() { return DECODER_DELAY; }
  get finished() { return this._native.isFinished(); }

  /**
   * Encode one chunk of PCM -> MP3 bytes for that chunk (possibly
   * empty). Mono: `encodeBuffer(left)`; stereo: `encodeBuffer(left,
   * right)` with both arrays the same length.
   */
  encodeBuffer(left, right) {
    const leftBytes = toS16Bytes(left, 'left');
    if (leftBytes.length === 0) return Buffer.alloc(0);
    if (this._channels === 1) {
      return this._native.encode(leftBytes, null);
    }
    if (right === undefined || right === null) {
      throw new TypeError('stereo encodeBuffer requires both left and right Int16Arrays');
    }
    const rightBytes = toS16Bytes(right, 'right');
    if (rightBytes.length !== leftBytes.length) {
      throw new RangeError(`left and right must have the same length: got ${leftBytes.length / 2} and ${rightBytes.length / 2} samples`);
    }
    return this._native.encode(leftBytes, rightBytes);
  }

  /**
   * Encode already-interleaved s16le PCM (L, R, L, R, ...) -> MP3
   * bytes. The fast path when the caller already has interleaved data:
   * no interleave copy. `pcm` is one `Int16Array` (or s16le bytes) whose
   * length is a multiple of `channels`.
   */
  encodeInterleaved(pcm) {
    const bytes = toS16Bytes(pcm, 'pcm');
    if (bytes.length === 0) return Buffer.alloc(0);
    if (bytes.length % (2 * this._channels) !== 0) {
      throw new RangeError(`interleaved PCM length ${bytes.length} is not a whole number of frames for ${this._channels} channel(s)`);
    }
    return this._native.encode(bytes, null);
  }

  /**
   * Encode into a caller-provided output buffer. Returns bytes written.
   * No `Buffer` is allocated per chunk. `out` must be large enough for
   * this chunk's packets; the error names the bytes needed.
   */
  encodeInto(left, right, out) {
    const leftBytes = toS16Bytes(left, 'left');
    const outBuf = toOutputBuffer(out, 'out');
    if (leftBytes.length === 0) return 0;
    if (this._channels === 1) {
      return this._native.encodeInto(leftBytes, null, outBuf);
    }
    if (right === undefined || right === null) {
      throw new TypeError('stereo encodeInto requires both left and right Int16Arrays');
    }
    const rightBytes = toS16Bytes(right, 'right');
    if (rightBytes.length !== leftBytes.length) {
      throw new RangeError(`left and right must have the same length: got ${leftBytes.length / 2} and ${rightBytes.length / 2} samples`);
    }
    return this._native.encodeInto(leftBytes, rightBytes, outBuf);
  }

  /**
   * End of input: flush the tail and return every remaining MP3 packet.
   * Must be called after the last `encodeBuffer()` — skipping it loses
   * the trailing frames. Idempotent: a second call returns an empty
   * buffer.
   */
  flush() {
    return this._native.flush();
  }

  /** `flush()` into a caller-provided output buffer. Returns bytes written. */
  flushInto(out) {
    return this._native.flushInto(toOutputBuffer(out, 'out'));
  }
}

/**
 * MP3 decoder — the round-trip / verification counterpart to
 * `Mp3Encoder`, and a usable decoder in its own right. Decodes a whole
 * MP3 byte slice in one call (the crate's streaming decoder underneath).
 *
 * ```js
 * const { Mp3Decoder } = require('@ndqp/bun-rusty-mp3');
 * const { sampleRate, channels, samples } = new Mp3Decoder().decode(mp3Bytes);
 * // samples: Int16Array, interleaved, in [-32768, 32767]
 * // The first ENCODER_DELAY + DECODER_DELAY (1057) samples are codec
 * // delay — trim them to recover the original alignment.
 * ```
 */
class Mp3Decoder {
  /**
   * Decode a whole MP3 slice -> `{ sampleRate, channels, samples }`
   * with `samples` an interleaved `Int16Array`.
   */
  decode(mp3) {
    const bytes = toOutputBuffer(mp3, 'mp3');
    const { sampleRate, channels, pcm } = decodeAll(bytes, false);
    return {
      sampleRate,
      channels,
      samples: new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2),
    };
  }

  /**
   * Decode a whole MP3 slice -> `{ sampleRate, channels, samples }`
   * with `samples` an interleaved `Float32Array` in [-1, 1] — the
   * decoder's native output, with no i16 quantisation.
   */
  decodeFloat32(mp3) {
    const bytes = toOutputBuffer(mp3, 'mp3');
    const { sampleRate, channels, pcm } = decodeAll(bytes, true);
    return {
      sampleRate,
      channels,
      samples: new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4),
    };
  }
}

/** Decode a whole MP3 slice — shorthand for `new Mp3Decoder().decode(mp3)`. */
function decodeMp3(mp3) {
  return new Mp3Decoder().decode(mp3);
}

/**
 * WAV header helper, for full @breezystack/lamejs compatibility.
 * Parses a RIFF/WAVE header so PCM can be pulled out of a WAV file and
 * fed to `Mp3Encoder`.
 *
 * ```js
 * const wav = WavHeader.readHeader(new DataView(arrayBuffer));
 * if (!wav) throw new Error('not a WAV file');
 * const samples = new Int16Array(arrayBuffer, wav.dataOffset, wav.dataLen / 2);
 * ```
 */
class WavHeader {
  constructor() {
    this.RIFF = 0x52494646;
    this.WAVE = 0x57415645;
    this.fmt_ = 0x666d7420;
    this.data = 0x64617461;
    this.dataOffset = 0;
    this.dataLen = 0;
    this.channels = 0;
    this.sampleRate = 0;
  }

  /**
   * Parse a WAV header from a `DataView`. Returns a `WavHeader`, or
   * `undefined` when the data is not a RIFF/WAVE file or is not PCM.
   * Throws on an extended fmt chunk (size other than 16 or 18).
   */
  static readHeader(dataView) {
    if (!(dataView instanceof DataView) || dataView.byteLength < 12) return undefined;
    if (dataView.getUint32(0, false) !== 0x52494646) return undefined; // 'RIFF'
    if (dataView.getUint32(8, false) !== 0x57415645) return undefined; // 'WAVE'
    const header = new WavHeader();
    let offset = 12;
    while (offset + 8 <= dataView.byteLength) {
      const chunkId = dataView.getUint32(offset, false);
      const chunkSize = dataView.getUint32(offset + 4, true);
      if (chunkId === 0x666d7420) { // 'fmt '
        if (chunkSize !== 16 && chunkSize !== 18) {
          throw new Error('extended fmt chunk not implemented');
        }
        if (offset + 8 + chunkSize > dataView.byteLength) return undefined;
        const audioFormat = dataView.getUint16(offset + 8, true);
        if (audioFormat !== 1) return undefined; // PCM only
        header.channels = dataView.getUint16(offset + 10, true);
        header.sampleRate = dataView.getUint32(offset + 12, true);
      } else if (chunkId === 0x64617461) { // 'data'
        header.dataOffset = offset + 8;
        header.dataLen = chunkSize;
        return header;
      }
      // Chunks are word-aligned: an odd-sized chunk has a pad byte.
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    return undefined;
  }

  /** Serialise this header as a 44-byte WAV header `ArrayBuffer`. */
  toBuffer() {
    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);
    view.setUint32(0, 0x52494646, false); // 'RIFF'
    view.setUint32(4, 36 + this.dataLen, true);
    view.setUint32(8, 0x57415645, false); // 'WAVE'
    view.setUint32(12, 0x666d7420, false); // 'fmt '
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, this.channels, true);
    view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, this.sampleRate * this.channels * 2, true);
    view.setUint16(32, this.channels * 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(36, 0x64617461, false); // 'data'
    view.setUint32(40, this.dataLen, true);
    return buffer;
  }
}

module.exports = {
  Mp3Encoder,
  Mp3Decoder,
  WavHeader,
  decodeMp3,
  SUPPORTED_SAMPLE_RATES,
  ENCODER_DELAY,
  DECODER_DELAY,
  samplesPerFrame,
};
