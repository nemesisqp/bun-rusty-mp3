'use strict';

// Mp3Decoder: round-trip quality, tag handling, float output, WavHeader.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WavHeader, decodeMp3 } from '../index.js';
import {
  Mp3Encoder, Mp3Decoder, TOTAL_DELAY, ENCODER_DELAY, DECODER_DELAY,
  sine, noise, chirp, encodeAll, rmsError, rmsLevel, bestLag, parseMp3Frames,
} from './helpers.mjs';

test('decoder: empty and garbage input decode to empty output, no throw', () => {
  const dec = new Mp3Decoder();
  assert.deepEqual(dec.decode(Buffer.alloc(0)), { sampleRate: 0, channels: 0, samples: new Int16Array(0) });
  const garbage = dec.decode(Buffer.from('this is not mp3 data at all, just text........'));
  assert.equal(garbage.samples.length, 0);
  assert.equal(garbage.sampleRate, 0);
});

test('decoder: round-trip sine is near-transparent at 128 kbps', () => {
  const pcm = sine(44100, 440, 44100);
  const mp3 = encodeAll(1, 44100, 128, pcm);
  const dec = new Mp3Decoder().decode(mp3);
  assert.equal(dec.sampleRate, 44100);
  assert.equal(dec.channels, 1);
  // Tag-aware: the stream lines up at exactly ENCODER+DECODER delay.
  assert.equal(ENCODER_DELAY + DECODER_DELAY, TOTAL_DELAY);
  assert.ok(rmsError(pcm, dec.samples, TOTAL_DELAY) < 0.005, `sine RMS error ${rmsError(pcm, dec.samples, TOTAL_DELAY)}`);
  // NOTE: do not assert bestLag == TOTAL_DELAY for a pure sine — the
  // signal is periodic (~100 samples), so many lags are near-perfect
  // aliases. The direct RMS at TOTAL_DELAY above is the real check.
  const lag = bestLag(pcm, dec.samples);
  assert.ok(lag.err < 0.005, `best-lag RMS error ${lag.err}`);
});

test('decoder: decoded length is exact frames, no tag frame counted', () => {
  // 1 s mono 44.1 kHz = 44100 samples -> 40 audio frames of 1152 after
  // the tag frame is skipped (46080 samples incl. delay + padding).
  const pcm = sine(44100, 440, 44100);
  const mp3 = encodeAll(1, 44100, 128, pcm);
  const dec = new Mp3Decoder().decode(mp3);
  assert.equal(dec.samples.length, 40 * 1152);
  // The first 1057 samples are codec delay (near-silence for a sine
  // starting at zero); the audio starts right after.
  assert.ok(rmsLevel(dec.samples, 0, 1000) < 0.01, 'first 1000 decoded samples should be delay silence');
});

test('decoder: white noise round-trip stays close', () => {
  // White noise is the hardest MP3 signal; measured error at 128 kbps
  // is 0.062 (lamejs is worse on the same signal at 0.124 — see the
  // interop test), so the threshold is 0.08, not 0.05.
  const pcm = noise(44100 * 2);
  const mp3 = encodeAll(1, 44100, 128, pcm);
  const dec = new Mp3Decoder().decode(mp3);
  const err = rmsError(pcm, dec.samples, TOTAL_DELAY);
  assert.ok(err < 0.08, `noise RMS error ${err}`);
});

test('decoder: chirp round-trip stays close across the spectrum', () => {
  const pcm = chirp(44100 * 2, 100, 10000, 44100);
  const mp3 = encodeAll(1, 44100, 192, pcm);
  const dec = new Mp3Decoder().decode(mp3);
  assert.ok(rmsError(pcm, dec.samples, TOTAL_DELAY) < 0.03, 'chirp RMS error');
});

test('decoder: stereo round-trip keeps both channels', () => {
  const rate = 44100;
  const left = sine(rate, 440, rate);
  const right = noise(rate, 0xabcdef);
  const mp3 = encodeAll(2, rate, 128, left, right);
  const dec = new Mp3Decoder().decode(mp3);
  assert.equal(dec.channels, 2);
  const dl = new Int16Array(rate);
  const dr = new Int16Array(rate);
  for (let i = 0; i < rate; i++) {
    dl[i] = dec.samples[(TOTAL_DELAY + i) * 2];
    dr[i] = dec.samples[(TOTAL_DELAY + i) * 2 + 1];
  }
  assert.ok(rmsError(left, dl) < 0.01, 'stereo left RMS error');
  // The noise channel gets 64 kbps of the shared 128 kbps stereo
  // budget: measured error 0.171, the same as lamejs (0.176) and the
  // same as mono noise at 64 kbps (0.173) — a bitrate effect, not a
  // stereo bug. At 256 kbps (128 kbps/channel) it drops to ~0.06.
  assert.ok(rmsError(right, dr) < 0.20, 'stereo right (noise) RMS error');
  const mp3hi = encodeAll(2, rate, 256, left, right);
  const dechi = new Mp3Decoder().decode(mp3hi);
  const drhi = new Int16Array(rate);
  for (let i = 0; i < rate; i++) drhi[i] = dechi.samples[(TOTAL_DELAY + i) * 2 + 1];
  assert.ok(rmsError(right, drhi) < 0.08, 'stereo right (noise) RMS error at 256 kbps');
});

test('decoder: decodeFloat32 is in [-1, 1] and agrees with the i16 output', () => {
  const pcm = sine(44100, 440, 44100);
  const mp3 = encodeAll(1, 44100, 128, pcm);
  const f32 = new Mp3Decoder().decodeFloat32(mp3);
  const i16 = new Mp3Decoder().decode(mp3);
  assert.equal(f32.sampleRate, 44100);
  assert.equal(f32.samples.length, i16.samples.length);
  for (let i = 0; i < f32.samples.length; i++) {
    assert.ok(f32.samples[i] >= -1 && f32.samples[i] <= 1, `f32 sample out of range: ${f32.samples[i]}`);
    const fromI16 = i16.samples[i] / 32768;
    assert.ok(Math.abs(f32.samples[i] - fromI16) < 1 / 32767 + 1e-6, 'f32/i16 disagree by more than 1 LSB');
  }
});

test('decoder: decodeMp3 shorthand matches new Mp3Decoder().decode', () => {
  const pcm = sine(22050, 440, 22050);
  const mp3 = encodeAll(1, 22050, 128, pcm);
  const a = decodeMp3(mp3);
  const b = new Mp3Decoder().decode(mp3);
  assert.equal(a.sampleRate, b.sampleRate);
  assert.deepEqual(a.samples, b.samples);
});

test('decoder: low sample rates round-trip (MPEG-2/2.5, 576-sample frames)', () => {
  for (const rate of [8000, 11025, 12000, 16000, 22050, 24000]) {
    const pcm = sine(rate, 440, rate);
    const mp3 = encodeAll(1, rate, 64, pcm);
    const dec = new Mp3Decoder().decode(mp3);
    assert.equal(dec.sampleRate, rate);
    assert.ok(rmsError(pcm, dec.samples, TOTAL_DELAY, rate) < 0.02, `${rate} Hz RMS error`);
  }
});

// --- WavHeader ---------------------------------------------------------------

function makeWav({ channels = 1, sampleRate = 44100, samples = 1152 } = {}) {
  const dataLen = samples * channels * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataLen, true);
  return buf;
}

test('WavHeader: parses a real WAV header and feeds Mp3Encoder', () => {
  const wavBuf = makeWav({ channels: 1, sampleRate: 44100, samples: 44100 });
  const wav = WavHeader.readHeader(new DataView(wavBuf));
  assert.ok(wav);
  assert.equal(wav.channels, 1);
  assert.equal(wav.sampleRate, 44100);
  assert.equal(wav.dataOffset, 44);
  assert.equal(wav.dataLen, 44100 * 2);
  const samples = new Int16Array(wavBuf, wav.dataOffset, wav.dataLen / 2);
  assert.equal(samples.length, 44100);
  // Stereo WAV too.
  const stereo = WavHeader.readHeader(new DataView(makeWav({ channels: 2, sampleRate: 48000, samples: 100 })));
  assert.equal(stereo.channels, 2);
  assert.equal(stereo.sampleRate, 48000);
  assert.equal(stereo.dataLen, 400);
});

test('WavHeader: invalid data returns undefined, extended fmt throws', () => {
  assert.equal(WavHeader.readHeader(new DataView(new ArrayBuffer(44))), undefined);
  assert.equal(WavHeader.readHeader(new DataView(Buffer.from('hello world, not wav').buffer)), undefined);
  const badFmt = makeWav();
  new DataView(badFmt).setUint32(16, 40, true); // fmt chunk size 40
  assert.throws(() => WavHeader.readHeader(new DataView(badFmt)), /extended fmt/);
  // Non-PCM format (3 = float) returns undefined.
  const float = makeWav();
  new DataView(float).setUint16(20, 3, true);
  assert.equal(WavHeader.readHeader(new DataView(float)), undefined);
});

test('WavHeader: toBuffer round-trips through readHeader', () => {
  const wav = new WavHeader();
  wav.channels = 2;
  wav.sampleRate = 48000;
  wav.dataLen = 9600;
  const parsed = WavHeader.readHeader(new DataView(wav.toBuffer()));
  assert.ok(parsed);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.sampleRate, 48000);
  assert.equal(parsed.dataLen, 9600);
  assert.equal(parsed.dataOffset, 44);
});

test('decoder: gapless — trimming delay+padding recovers the input length', () => {
  // The Xing tag records delay 528 and the end padding; a tag-aware
  // consumer trims 1057 from the front and the tag's padding from the
  // back to get exactly the input back. Here we check the front trim
  // plus that the decoded tail after the input is near-silence.
  const n = 44100;
  const pcm = sine(n, 440, 44100);
  const mp3 = encodeAll(1, 44100, 128, pcm);
  const dec = new Mp3Decoder().decode(mp3);
  assert.ok(rmsError(pcm, dec.samples, TOTAL_DELAY, n) < 0.005);
  const tail = dec.samples.length - TOTAL_DELAY - n;
  assert.ok(tail >= 0 && tail < 1152, `unexpected tail ${tail}`);
  assert.ok(rmsLevel(dec.samples, TOTAL_DELAY + n, tail) < 0.01, 'decoded tail is not padding silence');
});
