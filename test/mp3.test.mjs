'use strict';

// Mp3Encoder: API, validation, frame structure, determinism, edge cases.
// Round-trip quality assertions live in test/decoder.test.mjs; external
// validation (lamejs, ffmpeg) in test/interop.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Mp3Encoder, Mp3Decoder, TOTAL_DELAY, sine, noise, chirp,
  encodeAll, rmsError, rmsLevel, parseMp3Frames, firstFrameHasTag,
} from './helpers.mjs';

test('constructor defaults are lamejs-compatible (1ch, 44100 Hz, 128 kbps)', () => {
  const enc = new Mp3Encoder();
  assert.equal(enc.channels, 1);
  assert.equal(enc.sampleRate, 44100);
  assert.equal(enc.bitrateKbps, 128);
  assert.equal(enc.samplesPerFrame, 1152);
  assert.equal(enc.encoderDelay, 528);
  assert.equal(enc.decoderDelay, 529);
  assert.equal(enc.finished, false);
});

test('constructor rejects invalid channels / sample rates / bitrates', () => {
  assert.throws(() => new Mp3Encoder(0, 44100, 128), /channel/);
  assert.throws(() => new Mp3Encoder(3, 44100, 128), /channel/);
  assert.throws(() => new Mp3Encoder(1, 12345, 128), /sample rate/);
  assert.throws(() => new Mp3Encoder(1, 44100, 7), /bitrate/);
  assert.throws(() => new Mp3Encoder(1, 44100, 321), /bitrate/);
  assert.throws(() => new Mp3Encoder(1, 44100, 128, { vbrQuality: -1 }), /vbr/);
  assert.throws(() => new Mp3Encoder(1, 44100, 128, { vbrQuality: 10 }), /vbr/);
});

test('bitrate is snapped to the nearest legal Layer III value', () => {
  assert.equal(new Mp3Encoder(1, 44100, 127).bitrateKbps, 128);
  assert.equal(new Mp3Encoder(1, 44100, 100).bitrateKbps, 96);
  assert.equal(new Mp3Encoder(1, 44100, 320).bitrateKbps, 320);
  // MPEG-2/2.5 table tops out at 160: 200 snaps down to 160.
  assert.equal(new Mp3Encoder(1, 22050, 200).bitrateKbps, 160);
  assert.equal(new Mp3Encoder(1, 22050, 64).bitrateKbps, 64);
});

test('mono encode produces well-formed MP3 frames with a Xing/Info tag first', () => {
  const pcm = sine(44100, 440, 44100);
  const mp3 = encodeAll(1, 44100, 128, pcm);
  assert.ok(mp3.length > 1000, `mp3 too small: ${mp3.length}`);
  const frames = parseMp3Frames(mp3);
  assert.ok(frames.length >= 38, `expected >= 38 frames, got ${frames.length}`);
  for (const f of frames) {
    assert.equal(f.version, 1);
    assert.equal(f.bitrate, 128);
    assert.equal(f.sampleRate, 44100);
    assert.equal(f.channels, 1);
  }
  assert.equal(firstFrameHasTag(mp3), true);
});

test('stereo encode: frames are stereo, tag is present, L/R are not swapped', () => {
  const rate = 44100;
  const left = sine(rate, 440, rate);
  const right = sine(rate, 880, rate);
  const mp3 = encodeAll(2, rate, 128, left, right);
  const frames = parseMp3Frames(mp3);
  assert.ok(frames.length >= 38);
  for (const f of frames) assert.equal(f.channels, 2);
  assert.equal(firstFrameHasTag(mp3), true);
  // Decode and check each channel still carries its own tone.
  const dec = new Mp3Decoder().decode(mp3);
  assert.equal(dec.channels, 2);
  const n = rate;
  const dl = new Int16Array(n);
  const dr = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    dl[i] = dec.samples[(TOTAL_DELAY + i) * 2];
    dr[i] = dec.samples[(TOTAL_DELAY + i) * 2 + 1];
  }
  assert.ok(rmsError(left, dl) < 0.02, `left RMS error ${rmsError(left, dl)}`);
  assert.ok(rmsError(right, dr) < 0.02, `right RMS error ${rmsError(right, dr)}`);
  // Cross-check: decoded left must NOT match the right tone.
  assert.ok(rmsError(right, dl) > 0.1, 'left channel looks like the right tone');
  assert.ok(rmsError(left, dr) > 0.1, 'right channel looks like the left tone');
});

test('encodeBuffer may return empty chunks; flush drains the tail', () => {
  const enc = new Mp3Encoder(1, 44100, 128);
  const first = enc.encodeBuffer(new Int16Array(100));
  assert.equal(first.length, 0, 'a 100-sample chunk cannot fill a frame yet');
  const tail = enc.flush();
  assert.ok(tail.length > 0, 'flush must emit the tail frames');
  assert.ok(parseMp3Frames(Buffer.concat([first, tail])).length >= 2);
});

test('flush is idempotent and encode after flush throws', () => {
  const enc = new Mp3Encoder(1, 44100, 128);
  enc.encodeBuffer(sine(1152, 440, 44100));
  const t1 = enc.flush();
  assert.ok(t1.length > 0);
  assert.equal(enc.flush().length, 0);
  assert.equal(enc.finished, true);
  assert.throws(() => enc.encodeBuffer(sine(1152, 440, 44100)), /flush/);
});

test('empty input encodes to an empty stream and flushes to nothing meaningful', () => {
  const enc = new Mp3Encoder(1, 44100, 128);
  assert.equal(enc.encodeBuffer(new Int16Array(0)).length, 0);
  // No push at all: the format was never fixed, so finish emits nothing.
  assert.equal(enc.flush().length, 0);
});

test('tiny inputs (1 sample, 100 samples, 1151 samples) still produce decodable MP3', () => {
  for (const n of [1, 100, 1151, 1152, 1153]) {
    const pcm = sine(n, 440, 44100);
    const mp3 = encodeAll(1, 44100, 128, pcm);
    const frames = parseMp3Frames(mp3);
    assert.ok(frames.length >= 2, `n=${n}: expected >= 2 frames, got ${frames.length}`);
    const dec = new Mp3Decoder().decode(mp3);
    assert.equal(dec.sampleRate, 44100);
    assert.equal(dec.channels, 1);
    assert.ok(dec.samples.length >= 1152, `n=${n}: decoded ${dec.samples.length} samples`);
  }
});

test('non-multiple-of-frame lengths round-trip without loss of alignment', () => {
  for (const n of [1000, 5000, 10000, 44101]) {
    const pcm = sine(n, 440, 44100);
    const mp3 = encodeAll(1, 44100, 128, pcm);
    parseMp3Frames(mp3);
    const dec = new Mp3Decoder().decode(mp3);
    // The decoded stream is longer (padding); the first n samples after
    // the codec delay must match the input.
    assert.ok(rmsError(pcm, dec.samples, TOTAL_DELAY, n) < 0.01, `n=${n} RMS error`);
  }
});

test('encoding is deterministic: same input, byte-identical output', () => {
  const pcm = noise(44100 * 2);
  const a = encodeAll(1, 44100, 128, pcm);
  const b = encodeAll(1, 44100, 128, pcm);
  assert.ok(a.equals(b), 'two runs of the same input differ');
});

test('chunking does not change the output (1152-blocks vs one big push vs 576-blocks)', () => {
  const pcm = chirp(44100, 200, 4000, 44100);
  const by1152 = encodeAll(1, 44100, 128, pcm);
  const enc = new Mp3Encoder(1, 44100, 128);
  const big = Buffer.concat([enc.encodeBuffer(pcm), enc.flush()]);
  assert.ok(by1152.equals(big), 'one big push differs from 1152-blocks');
  const enc2 = new Mp3Encoder(1, 44100, 128);
  const parts = [];
  for (let i = 0; i < pcm.length; i += 576) {
    const b = enc2.encodeBuffer(pcm.subarray(i, i + 576));
    if (b.length) parts.push(b);
  }
  parts.push(enc2.flush());
  assert.ok(by1152.equals(Buffer.concat(parts)), '576-blocks differ from 1152-blocks');
});

test('encodeInterleaved is byte-identical to encodeBuffer(left, right)', () => {
  const rate = 44100;
  const left = sine(rate, 440, rate);
  const right = sine(rate, 880, rate);
  const interleaved = new Int16Array(rate * 2);
  for (let i = 0; i < rate; i++) {
    interleaved[2 * i] = left[i];
    interleaved[2 * i + 1] = right[i];
  }
  const encA = new Mp3Encoder(2, rate, 128);
  const a = Buffer.concat([encA.encodeBuffer(left, right), encA.flush()]);
  const encB = new Mp3Encoder(2, rate, 128);
  const b = Buffer.concat([encB.encodeInterleaved(interleaved), encB.flush()]);
  assert.ok(a.equals(b), 'interleaved path differs from L/R path');
  assert.throws(() => new Mp3Encoder(2, rate, 128).encodeInterleaved(new Int16Array(3)), /whole number/);
});

test('encodeInto / flushInto write the same bytes and report the count', () => {
  // 320 kbps is used here because at CBR MPEG-1 <= 256 kbps rusty_mp3
  // banks frames in its reservoir mode and emits nothing until flush()
  // (see the reservoir test below) — encodeInto can only write what
  // the encoder has actually emitted.
  const pcm = sine(44100, 440, 44100);
  const enc = new Mp3Encoder(1, 44100, 320);
  const out = Buffer.alloc(100000);
  let written = 0;
  for (let i = 0; i < pcm.length; i += 1152) {
    written += enc.encodeInto(pcm.subarray(i, i + 1152), null, out.subarray(written));
  }
  written += enc.flushInto(out.subarray(written));
  const viaInto = out.subarray(0, written);
  const viaBuffer = encodeAll(1, 44100, 320, pcm);
  assert.ok(Buffer.from(viaInto).equals(viaBuffer), 'encodeInto output differs from encodeBuffer output');
  // Too-small output is an error, not silent truncation.
  const enc2 = new Mp3Encoder(1, 44100, 320);
  assert.throws(() => enc2.encodeInto(sine(1152 * 4, 440, 44100), null, Buffer.alloc(10)), /too small/);
});

test('reservoir mode: CBR MPEG-1 at <= 256 kbps emits nothing until flush()', () => {
  // rusty_mp3's 3R1 reservoir-RD mode is default ON for CBR MPEG-1 at
  // <= 256 kbps: frames are banked and assembled at finish(), which is
  // also why its quality is close to LAME at these bitrates. The
  // lamejs collect-then-flush pattern still works unchanged — callers
  // just must not expect incremental output before flush().
  const pcm = sine(44100, 440, 44100);
  const enc = new Mp3Encoder(1, 44100, 128);
  let during = 0;
  for (let i = 0; i < pcm.length; i += 1152) {
    during += enc.encodeBuffer(pcm.subarray(i, i + 1152)).length;
  }
  assert.equal(during, 0, 'CBR 128k emitted bytes before flush');
  const tail = enc.flush();
  assert.ok(tail.length > 10000, `flush emitted only ${tail.length} bytes`);
  assert.ok(tail.equals(encodeAll(1, 44100, 128, pcm)), 'flush output differs from encodeAll');
  // ...while 320 kbps, VBR and MPEG-2/2.5 stream incrementally.
  for (const [label, mk] of [
    ['320k', () => new Mp3Encoder(1, 44100, 320)],
    ['VBR', () => new Mp3Encoder(1, 44100, 128, { vbr: 2 })],
    ['22050 Hz', () => new Mp3Encoder(1, 22050, 128)],
  ]) {
    const e = mk();
    let n = 0;
    const p = label === '22050 Hz' ? sine(22050, 440, 22050) : pcm;
    for (let i = 0; i < p.length; i += 1152) n += e.encodeBuffer(p.subarray(i, i + 1152)).length;
    assert.ok(n > 0, `${label} emitted nothing before flush`);
    e.flush();
  }
});

test('input validation: types, lengths, stereo rules', () => {
  const enc = new Mp3Encoder(1, 44100, 128);
  assert.throws(() => enc.encodeBuffer(new Float32Array(1152)), /Int16Array/);
  assert.throws(() => enc.encodeBuffer([1, 2, 3]), /Int16Array/);
  assert.throws(() => enc.encodeBuffer(123), /Int16Array/);
  // Buffer (s16le bytes) is accepted as an extension of the lamejs API.
  const buf = Buffer.from(sine(1152, 440, 44100).buffer);
  assert.ok(enc.encodeBuffer(buf).length >= 0);
  // Stereo: right is required and must match left's length.
  const stereo = new Mp3Encoder(2, 44100, 128);
  assert.throws(() => stereo.encodeBuffer(sine(1152, 440, 44100)), /both left and right/);
  assert.throws(
    () => stereo.encodeBuffer(sine(1152, 440, 44100), sine(100, 440, 44100)),
    /same length/,
  );
  // Mono: an extra right array is ignored, like lamejs (right = left).
  const monoA = new Mp3Encoder(1, 44100, 128);
  const monoB = new Mp3Encoder(1, 44100, 128);
  const pcm = sine(1152 * 4, 440, 44100);
  const a = Buffer.concat([monoA.encodeBuffer(pcm), monoA.flush()]);
  const b = Buffer.concat([monoB.encodeBuffer(pcm, sine(1152 * 4, 880, 44100)), monoB.flush()]);
  assert.ok(a.equals(b), 'mono with a right array should match mono without one');
});

test('Int16Array subarrays with a non-zero byteOffset encode correctly', () => {
  // The napi alignment pitfall: a view into a larger buffer must still work.
  const big = new Int16Array(44100 + 100);
  for (let i = 0; i < big.length; i++) big[i] = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 44100));
  const view = big.subarray(100, 100 + 44100);
  assert.ok(view.byteOffset > 0);
  const mp3 = encodeAll(1, 44100, 128, view);
  const dec = new Mp3Decoder().decode(mp3);
  assert.ok(rmsError(view, dec.samples, TOTAL_DELAY) < 0.01);
});

test('all nine MPEG sample rates encode and parse', () => {
  for (const rate of [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]) {
    const n = rate; // 1 s
    const pcm = sine(n, 440, rate);
    const mp3 = encodeAll(1, rate, 128, pcm);
    const frames = parseMp3Frames(mp3);
    assert.ok(frames.length >= 2, `${rate} Hz: no frames`);
    for (const f of frames) assert.equal(f.sampleRate, rate, `${rate} Hz: frame rate mismatch`);
    const dec = new Mp3Decoder().decode(mp3);
    assert.equal(dec.sampleRate, rate);
    assert.ok(rmsError(pcm, dec.samples, TOTAL_DELAY, n) < 0.02, `${rate} Hz RMS error`);
  }
});

test('CBR bitrates 64/96/128/192/320: frame bitrate matches, output decodes', () => {
  for (const kbps of [64, 96, 128, 192, 320]) {
    const pcm = sine(44100, 440, 44100);
    const mp3 = encodeAll(1, 44100, kbps, pcm);
    const frames = parseMp3Frames(mp3);
    for (const f of frames) assert.equal(f.bitrate, kbps, `${kbps} kbps: frame bitrate ${f.bitrate}`);
    const dec = new Mp3Decoder().decode(mp3);
    assert.ok(rmsError(pcm, dec.samples, TOTAL_DELAY) < 0.02, `${kbps} kbps RMS error`);
  }
});

test('VBR mode produces valid MP3 with a different size than CBR', () => {
  const pcm = chirp(44100 * 2, 200, 6000, 44100);
  const cbr = encodeAll(1, 44100, 128, pcm);
  const vbr = encodeAll(1, 44100, 128, pcm, undefined, { vbr: 2 });
  parseMp3Frames(vbr);
  assert.notEqual(vbr.length, cbr.length, 'VBR output is suspiciously identical to CBR');
  const dec = new Mp3Decoder().decode(vbr);
  assert.ok(rmsError(pcm, dec.samples, TOTAL_DELAY) < 0.02, 'VBR RMS error');
});

test('silence encodes at the CBR size and decodes to near-silence', () => {
  const pcm = new Int16Array(44100);
  const mp3 = encodeAll(1, 44100, 128, pcm);
  // CBR means silence costs the same as signal: 128 kbps * 1 s = 16000
  // bytes, plus the tag frame. (VBR would be smaller; CBR is fixed.)
  const sineMp3 = encodeAll(1, 44100, 128, sine(44100, 440, 44100));
  assert.ok(Math.abs(mp3.length - sineMp3.length) < 500, `silence ${mp3.length} vs sine ${sineMp3.length}`);
  const dec = new Mp3Decoder().decode(mp3);
  assert.ok(rmsLevel(dec.samples, TOTAL_DELAY, 44100) < 0.001, 'decoded silence is not silent');
});

test('full-scale and DC inputs do not produce NaN or errors', () => {
  const full = new Int16Array(44100).fill(32767);
  const mp3 = encodeAll(1, 44100, 128, full);
  parseMp3Frames(mp3);
  const dec = new Mp3Decoder().decode(mp3);
  for (let i = TOTAL_DELAY; i < TOTAL_DELAY + 1000; i++) {
    assert.ok(Number.isFinite(dec.samples[i]), 'non-finite decoded sample');
  }
  const dc = new Int16Array(44100).fill(16000);
  const mp3dc = encodeAll(1, 44100, 128, dc);
  const decdc = new Mp3Decoder().decode(mp3dc);
  assert.ok(Math.abs(rmsLevel(decdc.samples, TOTAL_DELAY, 44100) - 16000 / 32768) < 0.05, 'DC level not preserved');
});

test('10 s stereo encodes and decodes in reasonable time', () => {
  const rate = 44100;
  const n = rate * 10;
  const left = sine(n, 440, rate);
  const right = sine(n, 660, rate);
  const t0 = Date.now();
  const mp3 = encodeAll(2, rate, 128, left, right);
  const encodeMs = Date.now() - t0;
  assert.ok(mp3.length > 100000, `10 s stereo MP3 is only ${mp3.length} bytes`);
  parseMp3Frames(mp3);
  const dec = new Mp3Decoder().decode(mp3);
  assert.equal(dec.channels, 2);
  assert.ok(encodeMs < 5000, `10 s stereo took ${encodeMs} ms to encode`);
});
