'use strict';

// External validation: @breezystack/lamejs (the API we mirror) and ffmpeg
// (the reference MP3 implementation). These tests assert our output is
// *valid MP3 that other tools accept*, not that it beats anyone — the
// numbers for that live in bench/bench.mjs and docs/PERFORMANCE.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lamejs from '@breezystack/lamejs';
import {
  Mp3Encoder, Mp3Decoder, TOTAL_DELAY, sine, noise,
  encodeAll, rmsError, bestLag, parseMp3Frames,
} from './helpers.mjs';

let hasFfmpeg = true;
try {
  execSync('which ffmpeg', { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

function lameEncode(channels, sampleRate, kbps, left, right) {
  const enc = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
  const chunks = [];
  for (let i = 0; i < left.length; i += 1152) {
    const buf = channels === 1
      ? enc.encodeBuffer(left.subarray(i, i + 1152))
      : enc.encodeBuffer(left.subarray(i, i + 1152), right.subarray(i, i + 1152));
    if (buf.length > 0) chunks.push(Buffer.from(buf));
  }
  const tail = enc.flush();
  if (tail.length > 0) chunks.push(Buffer.from(tail));
  return Buffer.concat(chunks);
}

/** Decode an MP3 file with ffmpeg to raw s16le PCM. Returns Int16Array. */
function ffmpegDecode(mp3, { channels = 1, sampleRate = 44100 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-rusty-mp3-'));
  try {
    const inFile = path.join(dir, 'in.mp3');
    const outFile = path.join(dir, 'out.pcm');
    fs.writeFileSync(inFile, mp3);
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-i', inFile,
      '-f', 's16le', '-ac', String(channels), '-ar', String(sampleRate), outFile,
    ]);
    const raw = fs.readFileSync(outFile);
    return new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('lamejs: our decoder reads lamejs output (lag = LAME 576 + our decoder 529)', () => {
  const pcm = sine(44100, 440, 44100);
  const mp3 = lameEncode(1, 44100, 128, pcm);
  const frames = parseMp3Frames(mp3);
  assert.ok(frames.length >= 38, `lamejs produced ${frames.length} frames`);
  for (const f of frames) assert.equal(f.bitrate, 128);
  const dec = new Mp3Decoder().decode(mp3);
  // lamejs writes no Xing tag, so our decoder does not skip a frame;
  // the lag is LAME's encoder delay (576) + our decoder delay (529).
  const lag = bestLag(pcm, dec.samples);
  assert.ok(lag.lag >= 1000 && lag.lag <= 1200, `lamejs round-trip lag ${lag.lag}`);
  assert.ok(lag.err < 0.02, `lamejs round-trip RMS error ${lag.err}`);
});

test('lamejs: our output has the same frame count as lamejs for the same input', () => {
  const pcm = sine(44100, 440, 44100);
  const ours = encodeAll(1, 44100, 128, pcm);
  const theirs = lameEncode(1, 44100, 128, pcm);
  const oursFrames = parseMp3Frames(ours);
  const theirsFrames = parseMp3Frames(theirs);
  // Ours has one extra frame: the Xing/Info tag. The audio frame count matches.
  assert.equal(oursFrames.length, theirsFrames.length + 1);
  assert.equal(oursFrames.length - 1, 40);
});

test('ffmpeg: decodes our MP3 to the original PCM (gapless trim applied)', { skip: !hasFfmpeg }, () => {
  const pcm = sine(44100, 440, 44100);
  const mp3 = encodeAll(1, 44100, 128, pcm);
  const decoded = ffmpegDecode(mp3);
  // ffmpeg reads the Xing tag and trims delay + padding: the output
  // should be the input length, aligned at lag 0.
  assert.ok(Math.abs(decoded.length - pcm.length) <= 1152, `ffmpeg output ${decoded.length} vs input ${pcm.length}`);
  const n = Math.min(decoded.length, pcm.length);
  assert.ok(rmsError(pcm.subarray(0, n), decoded, 0, n) < 0.01, 'ffmpeg-decoded RMS error');
});

test('ffmpeg: decodes our stereo MP3 with channels intact', { skip: !hasFfmpeg }, () => {
  const rate = 44100;
  const left = sine(rate, 440, rate);
  const right = sine(rate, 880, rate);
  const mp3 = encodeAll(2, rate, 128, left, right);
  const decoded = ffmpegDecode(mp3, { channels: 2, sampleRate: rate });
  const n = Math.min(rate, decoded.length / 2);
  const dl = new Int16Array(n);
  const dr = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    dl[i] = decoded[2 * i];
    dr[i] = decoded[2 * i + 1];
  }
  assert.ok(rmsError(left.subarray(0, n), dl) < 0.02, 'ffmpeg stereo left RMS error');
  assert.ok(rmsError(right.subarray(0, n), dr) < 0.02, 'ffmpeg stereo right RMS error');
});

test('ffmpeg: decodes our VBR and low-rate MP3', { skip: !hasFfmpeg }, () => {
  const pcm = sine(22050, 440, 22050);
  const vbr = encodeAll(1, 22050, 128, pcm, undefined, { vbr: 2 });
  const dec = ffmpegDecode(vbr, { channels: 1, sampleRate: 22050 });
  assert.ok(Math.abs(dec.length - pcm.length) <= 576, `ffmpeg VBR output ${dec.length}`);
  assert.ok(rmsError(pcm.subarray(0, Math.min(dec.length, pcm.length)), dec, 0, Math.min(dec.length, pcm.length)) < 0.02);
});

test('ffmpeg: ffprobe reports the right format for our MP3', { skip: !hasFfmpeg }, () => {
  const pcm = sine(44100, 440, 44100);
  const mp3 = encodeAll(2, 44100, 128, sine(44100, 440, 44100), sine(44100, 880, 44100));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-rusty-mp3-'));
  try {
    const inFile = path.join(dir, 'in.mp3');
    fs.writeFileSync(inFile, mp3);
    const probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate',
      '-show_entries', 'format=duration', '-of', 'json', inFile,
    ], { encoding: 'utf8' }));
    const stream = probe.streams[0];
    assert.equal(stream.codec_name, 'mp3');
    assert.equal(stream.sample_rate, '44100');
    assert.equal(stream.channels, 2);
    assert.ok(Math.abs(parseFloat(probe.format.duration) - 1.0) < 0.1, `duration ${probe.format.duration}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('noise: our encoder and lamejs both decode cleanly via ffmpeg', { skip: !hasFfmpeg }, () => {
  // White noise is the hardest MP3 signal (full spectrum, no masking
  // to exploit), so the thresholds here are looser than for tones.
  // Measured on this machine: ours 0.062, lamejs 0.124 (best lag).
  const pcm = noise(44100);
  const ours = ffmpegDecode(encodeAll(1, 44100, 128, pcm));
  const theirs = ffmpegDecode(lameEncode(1, 44100, 128, pcm));
  // Ours: ffmpeg trims the Xing tag delay, so lag 0 is correct.
  const n = Math.min(ours.length, pcm.length);
  const oursErr = rmsError(pcm.subarray(0, n), ours, 0, n);
  assert.ok(oursErr < 0.08, `ours noise RMS error ${oursErr}`);
  // lamejs writes no Xing tag, so ffmpeg does not trim its 576-sample
  // encoder delay: find the true lag instead of assuming 0.
  const lag = bestLag(pcm, theirs);
  assert.ok(lag.lag >= 1000 && lag.lag <= 1200, `lamejs noise lag ${lag.lag}`);
  assert.ok(lag.err < 0.15, `lamejs noise RMS error ${lag.err}`);
});
