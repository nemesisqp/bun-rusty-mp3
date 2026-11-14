// Compile-only check that index.d.ts matches the documented API.
import { Mp3Encoder, Mp3Decoder, WavHeader, decodeMp3, samplesPerFrame } from '../index.js';

const enc = new Mp3Encoder(2, 44100, 128, { vbrQuality: 2 });
const left = new Int16Array(1152);
const right = new Int16Array(1152);
const chunk: Buffer = enc.encodeBuffer(left, right);
const tail: Buffer = enc.flush();
const n: number = enc.encodeInto(left, right, Buffer.alloc(8192));
const inter: Buffer = enc.encodeInterleaved(new Int16Array(2304));
const bitrate: number = enc.bitrateKbps;
const spf: number = enc.samplesPerFrame;
const finished: boolean = enc.finished;
const spf2: number = samplesPerFrame(44100);

const dec = new Mp3Decoder();
const out = dec.decode(chunk);
const samples: Int16Array = out.samples;
const rate: number = out.sampleRate;
const f32 = dec.decodeFloat32(chunk);
const f32samples: Float32Array = f32.samples;
const short = decodeMp3(chunk);

const wav = WavHeader.readHeader(new DataView(new ArrayBuffer(44)));
const wavBuf: ArrayBuffer = new WavHeader().toBuffer();
void n; void bitrate; void spf; void finished; void spf2; void samples; void rate;
void f32samples; void short; void wav; void wavBuf; void chunk; void tail; void inter;
