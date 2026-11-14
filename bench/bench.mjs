// Benchmark: bun-rusty-mp3 vs @breezystack/lamejs (pure-JS LAME port).
// Encodes 10 s of PCM and reports wall time + realtime factor. Run with
// `bun bench/bench.mjs` (Bun) or `node bench/bench.mjs` (Node).
// Numbers are machine-specific — see docs/PERFORMANCE.md for method.

import * as lamejs from '@breezystack/lamejs';
import { Mp3Encoder, Mp3Decoder } from '../index.js';

function sine(n, freq, rate, amp = 0.5) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / rate));
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

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function timeIt(fn, runs = 3) {
  const times = [];
  let result;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    result = fn();
    times.push(performance.now() - t0);
  }
  return { ms: median(times), result };
}

function encodeOurs(channels, rate, kbps, left, right) {
  const enc = new Mp3Encoder(channels, rate, kbps);
  const chunks = [];
  for (let i = 0; i < left.length; i += 1152) {
    const buf = channels === 1
      ? enc.encodeBuffer(left.subarray(i, i + 1152))
      : enc.encodeBuffer(left.subarray(i, i + 1152), right.subarray(i, i + 1152));
    if (buf.length > 0) chunks.push(buf);
  }
  const tail = enc.flush();
  if (tail.length > 0) chunks.push(tail);
  return Buffer.concat(chunks);
}

function encodeLame(channels, rate, kbps, left, right) {
  const enc = new lamejs.Mp3Encoder(channels, rate, kbps);
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

const rate = 44100;
const seconds = 10;
const n = rate * seconds;
const runtime = typeof Bun !== 'undefined' ? `Bun ${Bun.version}` : `Node ${process.version}`;
console.log(`bun-rusty-mp3 bench — ${runtime}, ${process.platform}-${process.arch}`);
console.log(`input: ${seconds} s, ${rate} Hz, 128 kbps (median of 3 runs)\n`);

const cases = [
  { name: 'stereo music-like (chirp L / noise R)', channels: 2, left: sine(n, 440, rate), right: noise(n) },
  { name: 'stereo sine 440/880 Hz', channels: 2, left: sine(n, 440, rate), right: sine(n, 880, rate) },
  { name: 'mono sine 440 Hz', channels: 1, left: sine(n, 440, rate), right: null },
];

const rows = [];
for (const c of cases) {
  const ours = timeIt(() => encodeOurs(c.channels, rate, 128, c.left, c.right));
  const lame = timeIt(() => encodeLame(c.channels, rate, 128, c.left, c.right));
  const speedup = lame.ms / ours.ms;
  rows.push({ case: c.name, oursMs: ours.ms, lameMs: lame.ms, speedup, oursBytes: ours.result.length, lameBytes: lame.result.length });
  console.log(`${c.name}`);
  console.log(`  bun-rusty-mp3: ${ours.ms.toFixed(1)} ms (${(seconds / (ours.ms / 1000)).toFixed(0)}x realtime), ${ours.result.length} bytes`);
  console.log(`  lamejs:        ${lame.ms.toFixed(1)} ms (${(seconds / (lame.ms / 1000)).toFixed(0)}x realtime), ${lame.result.length} bytes`);
  console.log(`  speedup:       ${speedup.toFixed(2)}x\n`);
}

// Decode bench (ours only — lamejs has no decoder).
const mp3 = encodeOurs(2, rate, 128, cases[0].left, cases[0].right);
const dec = timeIt(() => new Mp3Decoder().decode(mp3));
console.log(`decode (ours, 10 s stereo): ${dec.ms.toFixed(1)} ms (${(seconds / (dec.ms / 1000)).toFixed(0)}x realtime), ${dec.result.samples.length} samples`);

console.log('\nJSON:');
console.log(JSON.stringify({ runtime, seconds, rate, kbps: 128, rows, decodeMs: dec.ms }, null, 2));
