// Basic usage — run with `node examples/basic.mjs` or `bun examples/basic.mjs`.
import { Mp3Encoder, Mp3Decoder } from '../index.js';

const rate = 44100;
const seconds = 1;
const left = new Int16Array(rate * seconds);
for (let i = 0; i < left.length; i++) {
  left[i] = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate));
}

const encoder = new Mp3Encoder(1, rate, 128);
const mp3Data = [];
for (let i = 0; i < left.length; i += 1152) {
  const buf = encoder.encodeBuffer(left.subarray(i, i + 1152));
  if (buf.length > 0) mp3Data.push(buf);
}
const tail = encoder.flush();
if (tail.length > 0) mp3Data.push(tail);
const mp3 = Buffer.concat(mp3Data);
console.log(`encoded ${left.length} samples -> ${mp3.length} bytes of MP3`);

const { sampleRate, channels, samples } = new Mp3Decoder().decode(mp3);
console.log(`decoded: ${sampleRate} Hz, ${channels} channel(s), ${samples.length} samples`);
// Trim the 528 + 529 codec delay to recover the original alignment.
const trimmed = samples.subarray(528 + 529, 528 + 529 + left.length);
let err = 0;
for (let i = 0; i < left.length; i++) err += ((trimmed[i] - left[i]) / 32768) ** 2;
console.log(`round-trip RMS error: ${Math.sqrt(err / left.length).toFixed(5)}`);
