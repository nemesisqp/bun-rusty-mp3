'use strict';

// Shared helpers for the bun-rusty-mp3 tests. No test framework magic:
// plain functions, used by both node:test and bun test.

import { Mp3Encoder, Mp3Decoder, ENCODER_DELAY, DECODER_DELAY } from '../index.js';

const TOTAL_DELAY = ENCODER_DELAY + DECODER_DELAY; // 1057 samples/channel

function sine(n, freq, rate, amp = 0.5) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / rate));
  }
  return out;
}

function noise(n, seed = 0x12345678, amp = 0.5) {
  const out = new Int16Array(n);
  let state = seed >>> 0;
  for (let i = 0; i < n; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = Math.round(amp * 32767 * ((state >>> 0) / 4294967295 - 0.5) * 2);
  }
  return out;
}

function chirp(n, f0, f1, rate, amp = 0.5) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * (n / rate)));
    out[i] = Math.round(amp * 32767 * Math.sin(phase));
  }
  return out;
}

/** Encode a whole Int16Array (mono) or {left, right} (stereo) in 1152-sample blocks, then flush. */
function encodeAll(channels, sampleRate, kbps, left, right, options) {
  const enc = new Mp3Encoder(channels, sampleRate, kbps, options);
  const chunks = [];
  const block = 1152;
  for (let i = 0; i < left.length; i += block) {
    const buf = channels === 1
      ? enc.encodeBuffer(left.subarray(i, i + block))
      : enc.encodeBuffer(left.subarray(i, i + block), right.subarray(i, i + block));
    if (buf.length > 0) chunks.push(buf);
  }
  const tail = enc.flush();
  if (tail.length > 0) chunks.push(tail);
  return Buffer.concat(chunks);
}

/** RMS error between Int16Arrays `a` (reference) and `b` starting at `bOffset`, over `n` samples. */
function rmsError(a, b, bOffset = 0, n = a.length) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = (b[bOffset + i] - a[i]) / 32768;
    s += d * d;
  }
  return Math.sqrt(s / n);
}

/** RMS level of an Int16Array (0..1). */
function rmsLevel(a, offset = 0, n = a.length - offset) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const v = a[offset + i] / 32768;
    s += v * v;
  }
  return Math.sqrt(s / n);
}

/** Best lag (0..maxLag) minimising RMS error of `decoded` vs `reference`. */
function bestLag(reference, decoded, maxLag = 4000) {
  const n = Math.min(reference.length, decoded.length - maxLag, 20000);
  let best = { lag: 0, err: Infinity };
  for (let lag = 0; lag <= maxLag; lag++) {
    const err = rmsError(reference.subarray(0, n), decoded, lag, n);
    if (err < best.err) best = { lag, err };
  }
  return best;
}

// --- MP3 frame parsing (for structural assertions) -------------------------

const BITRATES_V1 = [null, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES = {
  // version index -> [rate index 0, 1, 2]
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

/** Parse every MP3 frame header in `buf`. Throws on a bad sync / header. */
function parseMp3Frames(buf) {
  const frames = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) {
      throw new Error(`bad frame sync at offset ${pos}: ${buf[pos].toString(16)} ${buf[pos + 1].toString(16)}`);
    }
    const versionBits = (buf[pos + 1] >> 3) & 0x03;
    const layerBits = (buf[pos + 1] >> 1) & 0x03;
    if (layerBits !== 1) throw new Error(`not Layer III at offset ${pos} (layer bits ${layerBits})`);
    if (versionBits === 1) throw new Error(`reserved MPEG version at offset ${pos}`);
    const bitrateIdx = (buf[pos + 2] >> 4) & 0x0f;
    const rateIdx = (buf[pos + 2] >> 2) & 0x03;
    const padding = (buf[pos + 2] >> 1) & 0x01;
    const channelMode = (buf[pos + 3] >> 6) & 0x03;
    if (bitrateIdx === 0 || bitrateIdx === 15) throw new Error(`bad bitrate index ${bitrateIdx} at offset ${pos}`);
    if (rateIdx === 3) throw new Error(`bad sample-rate index at offset ${pos}`);
    const version = versionBits === 3 ? 1 : 2; // 1 = MPEG-1, 2 = MPEG-2/2.5
    const bitrate = (version === 1 ? BITRATES_V1 : BITRATES_V2)[bitrateIdx];
    const sampleRate = RATES[versionBits][rateIdx];
    const channels = channelMode === 3 ? 1 : 2;
    // Layer III frame size: 144 * bitrate / rate for MPEG-1 (1152 samples),
    // 72 * bitrate / rate for MPEG-2/2.5 (576 samples).
    const coeff = version === 1 ? 144 : 72;
    const frameSize = Math.floor((coeff * bitrate * 1000) / sampleRate) + padding;
    frames.push({ offset: pos, version, bitrate, sampleRate, channels, frameSize, channelMode });
    pos += frameSize;
  }
  if (pos !== buf.length) {
    throw new Error(`trailing ${buf.length - pos} bytes after last frame (total ${buf.length})`);
  }
  return frames;
}

/** Does the first frame carry a Xing/Info tag? (offset depends on version/channels.) */
function firstFrameHasTag(buf) {
  const frames = parseMp3Frames(buf);
  if (frames.length === 0) return false;
  const f = frames[0];
  const sideInfo = f.version === 1 ? (f.channels === 2 ? 32 : 17) : (f.channels === 2 ? 17 : 9);
  const at = 4 + sideInfo;
  const tag = buf.subarray(at, at + 4).toString('latin1');
  return tag === 'Xing' || tag === 'Info';
}

export {
  Mp3Encoder,
  Mp3Decoder,
  ENCODER_DELAY,
  DECODER_DELAY,
  TOTAL_DELAY,
  sine,
  noise,
  chirp,
  encodeAll,
  rmsError,
  rmsLevel,
  bestLag,
  parseMp3Frames,
  firstFrameHasTag,
};
