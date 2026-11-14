//! N-API binding from `rusty_mp3` (pure-Rust MP3 codec) to Node.js / Bun.
//!
//! Design — keep the speedup across the JS/Rust boundary:
//!
//! * **Pass buffers by reference.** Inputs arrive as [`BufferSlice`], a
//!   zero-copy view of the caller's `Buffer`/`Uint8Array` — never a `Vec`
//!   copied per call. `push_pcm_s16le` takes the raw s16le bytes straight,
//!   so a mono `Int16Array` is encoded with no copy at all. Stereo
//!   `lamejs`-style input (two separate `Int16Array`s) must be interleaved
//!   first — that copy is unavoidable and happens here, in Rust, into a
//!   reused scratch buffer, never in JS.
//! * **Reuse output buffers.** The interleave scratch and the drain scratch
//!   live on the struct and only grow (never shrink, never re-allocate per
//!   call). `encode_into` / `flush_into` write straight into a
//!   caller-provided buffer: no `Buffer` allocated per chunk.
//! * **Sync only.** No threadsafe functions, no async work — the surface
//!   Bun had N-API crashes with in the past is avoided entirely.
//!
//! The JS wrapper (`lib/wrapper.js`) owns all defaults, validation and
//! the lamejs-compatible surface; this layer takes only primitives so the
//! N-API surface stays small and fast.
//!
//! Mapping to `rusty_mp3` 1.0.6 (verified against the vendored crate
//! source, not just its README):
//! * `Mp3Encoder::new(Mp3EncoderConfig { bitrate_kbps, vbr_quality })` —
//!   channels / sample rate are NOT in the config; the first push fixes
//!   them. The JS wrapper stores them and passes them on every push.
//! * `push_pcm_s16` / `push_pcm_s16le` take interleaved PCM; one frame is
//!   1152 samples/channel (MPEG-1) or 576 (MPEG-2/2.5).
//! * `next_packet()` follows FFmpeg's drain protocol: `Err(Again)` = feed
//!   more PCM, `Err(Eof)` = finished and drained. Neither is a failure.
//! * `finish()` is idempotent; the first packet out is the LAME-style
//!   Info/Xing tag frame (encoder delay 528, decoder delay 529), which
//!   makes the stream gapless for tag-aware players.
//! * `Mp3Decoder::next_frame()` returns `DecodedAudio { sample_rate,
//!   channels, samples: Vec<f32> }` — interleaved f32 in [-1, 1], NOT i16.

use napi::bindgen_prelude::{Buffer, BufferSlice};
use napi::{Error as NapiError, Result, Status};
use napi_derive::napi;
use rusty_mp3::{
    encode::lametag::{DECODER_DELAY, ENCODER_DELAY},
    encoder_header, vbr_quality_index, Error as Mp3Error, Mp3Decoder, Mp3Encoder, Mp3EncoderConfig,
};

/// The nine MPEG Layer III sample rates (Hz). Anything else is rejected
/// by `rusty_mp3` on the first push with `Error::Unsupported`.
const SUPPORTED_SAMPLE_RATES: [u32; 9] =
    [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

fn map_err(err: Mp3Error) -> NapiError {
    NapiError::new(Status::GenericFailure, err.to_string())
}

fn bad_arg(msg: &str) -> NapiError {
    NapiError::new(Status::InvalidArg, msg.to_string())
}

fn is_again_or_eof(err: &Mp3Error) -> bool {
    matches!(err, Mp3Error::Again | Mp3Error::Eof)
}

/// Interleave two s16le byte slices (`left`, `right`) into `out` as
/// `[l0, r0, l1, r1, ...]`. Pure function (no napi) so the Rust unit
/// tests can cover it — see the note in `mod tests` about why tests
/// here must not touch napi types.
fn interleave_s16le(left: &[u8], right: &[u8], out: &mut [i16]) {
    debug_assert_eq!(left.len(), right.len());
    debug_assert_eq!(out.len(), left.len());
    for i in 0..left.len() / 2 {
        out[2 * i] = i16::from_le_bytes([left[2 * i], left[2 * i + 1]]);
        out[2 * i + 1] = i16::from_le_bytes([right[2 * i], right[2 * i + 1]]);
    }
}

/// Samples per MP3 frame for a sample rate: 1152 for MPEG-1
/// (32/44.1/48 kHz), 576 for MPEG-2/2.5 (all lower rates).
fn samples_per_frame_for(rate: u32) -> u32 {
    match rate {
        32000 | 44100 | 48000 => 1152,
        _ => 576,
    }
}

#[inline]
fn f32_to_i16(sample: f32) -> i16 {
    // Round to nearest, saturate. Same convention as the crate's own
    // s16 conversion (i16 / 32768.0 on the way in).
    let v = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i32;
    v.clamp(-32768, 32767) as i16
}

/// Creation options, passed as one JS object to `create_mp3` — one
/// argument instead of four, and the field names are the contract with
/// `lib/wrapper.js`.
#[napi(object)]
pub struct Mp3Options {
    pub channels: u32,
    pub sample_rate: u32,
    pub bitrate_kbps: u32,
    /// LAME-style VBR quality index 0 (best) .. 9 (smallest), or `null`
    /// for CBR. Mapped through `rusty_mp3::vbr_quality_index` to the
    /// target-average-bitrate the crate's `vbr_quality` expects.
    pub vbr_quality_index: Option<f64>,
}

/// Decoded MP3, as one JS object: `pcm` is s16le bytes by default, or
/// f32le bytes when `as_float` was requested (see `decode_all`).
#[napi(object)]
pub struct DecodedPcm {
    pub sample_rate: u32,
    pub channels: u32,
    pub pcm: Buffer,
}

/// One native encoder. The JS `Mp3Encoder` (lamejs shape) is a thin
/// wrapper over this struct.
#[napi]
pub struct NativeMp3 {
    encoder: Mp3Encoder,
    channels: u16,
    sample_rate: u32,
    /// Bitrate after `rusty_mp3`'s snapping to the nearest legal Layer
    /// III value for the MPEG version (e.g. 127 -> 128, 100 -> 96).
    bitrate_kbps: u32,
    finished: bool,
    /// Reused stereo interleave scratch: `left[i], right[i], ...`.
    /// Grows to the largest chunk seen, never shrinks.
    interleave_scratch: Vec<i16>,
    /// Reused drain scratch for the `*_into` methods.
    drain_scratch: Vec<u8>,
}

impl NativeMp3 {
    /// Plain Rust construction (not exposed to JS). Fallible, so it lives
    /// here instead of in a napi constructor, which in napi 3.x must
    /// return `Self` directly. The JS entry point is the free function
    /// `create_mp3` at the bottom of this file.
    pub fn new(opts: &Mp3Options) -> Result<Self> {
        if opts.channels != 1 && opts.channels != 2 {
            return Err(bad_arg("channels must be 1 (mono) or 2 (stereo)"));
        }
        if !SUPPORTED_SAMPLE_RATES.contains(&opts.sample_rate) {
            return Err(bad_arg(
                "sample rate must be one of 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000 Hz",
            ));
        }
        if !(8..=320).contains(&opts.bitrate_kbps) {
            return Err(bad_arg("bitrate must be 8-320 kbps"));
        }
        let vbr_quality = match opts.vbr_quality_index {
            Some(q) => {
                if !(0.0..=9.0).contains(&q) {
                    return Err(bad_arg(
                        "vbr quality index must be 0 (best) to 9 (smallest)",
                    ));
                }
                Some(vbr_quality_index(q as f32))
            }
            None => None,
        };
        // Validates the rate and gives us the snapped bitrate up front,
        // so `bitrate_kbps()` reports what the stream actually uses.
        let header = encoder_header(opts.sample_rate, opts.channels as u16, opts.bitrate_kbps)
            .map_err(map_err)?;
        let encoder = Mp3Encoder::new(Mp3EncoderConfig {
            bitrate_kbps: opts.bitrate_kbps,
            vbr_quality,
        });
        Ok(Self {
            encoder,
            channels: opts.channels as u16,
            sample_rate: opts.sample_rate,
            bitrate_kbps: header.bitrate_kbps,
            finished: false,
            interleave_scratch: Vec::new(),
            drain_scratch: Vec::new(),
        })
    }

    fn push_pcm(&mut self, left: &[u8], right: Option<&[u8]>) -> Result<()> {
        if self.finished {
            return Err(bad_arg(
                "cannot encode after flush(): this Mp3Encoder is finished",
            ));
        }
        if left.len() % 2 != 0 {
            return Err(bad_arg("PCM byte length must be even (s16le samples)"));
        }
        let rate = self.sample_rate;
        if self.channels == 1 {
            // Zero-copy: the s16le bytes go straight into the encoder.
            // A `right` buffer passed for a mono encoder is ignored
            // (lamejs sets right = left for mono; the wrapper does this).
            self.encoder
                .push_pcm_s16le(left, 1, rate)
                .map_err(map_err)?;
            return Ok(());
        }
        let right = match right {
            Some(r) => r,
            // No `right` for stereo means `left` is already interleaved
            // s16le (the `encodeInterleaved` fast path) — zero-copy.
            None => {
                self.encoder
                    .push_pcm_s16le(left, 2, rate)
                    .map_err(map_err)?;
                return Ok(());
            }
        };
        if right.len() != left.len() {
            return Err(bad_arg(&format!(
                "left and right must have the same length: got {} and {} bytes",
                left.len(),
                right.len()
            )));
        }
        if right.len() % 2 != 0 {
            return Err(bad_arg("PCM byte length must be even (s16le samples)"));
        }
        let n = left.len() / 2;
        if self.interleave_scratch.len() < n * 2 {
            self.interleave_scratch.resize(n * 2, 0);
        }
        interleave_s16le(left, right, &mut self.interleave_scratch[..n * 2]);
        self.encoder
            .push_pcm_s16(&self.interleave_scratch[..n * 2], 2, rate)
            .map_err(map_err)?;
        Ok(())
    }

    /// Drain every packet currently available into a fresh `Vec`.
    /// `Again` / `Eof` end the drain; any other error is real.
    fn drain_packets(&mut self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        loop {
            match self.encoder.next_packet() {
                Ok(packet) => out.extend_from_slice(&packet),
                Err(e) if is_again_or_eof(&e) => break,
                Err(e) => return Err(map_err(e)),
            }
        }
        Ok(out)
    }

    /// Drain every packet currently available into the reused scratch.
    fn drain_to_scratch(&mut self) -> Result<()> {
        self.drain_scratch.clear();
        loop {
            match self.encoder.next_packet() {
                Ok(packet) => self.drain_scratch.extend_from_slice(&packet),
                Err(e) if is_again_or_eof(&e) => break,
                Err(e) => return Err(map_err(e)),
            }
        }
        Ok(())
    }
}

#[napi]
impl NativeMp3 {
    #[napi]
    pub fn channels(&self) -> u32 {
        self.channels as u32
    }

    #[napi]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    #[napi]
    pub fn bitrate_kbps(&self) -> u32 {
        self.bitrate_kbps
    }

    /// Samples per MP3 frame for this stream (1152 MPEG-1, 576 MPEG-2/2.5).
    #[napi]
    pub fn samples_per_frame(&self) -> u32 {
        samples_per_frame_for(self.sample_rate)
    }

    /// Encoder delay in samples per channel (528): the LAME-style
    /// Info/Xing tag's delay field. Trim this many samples from the
    /// start of a decoded stream (plus the decoder delay, 529) to
    /// recover the original alignment.
    #[napi]
    pub fn encoder_delay(&self) -> u32 {
        ENCODER_DELAY as u32
    }

    /// Decoder delay in samples per channel (529).
    #[napi]
    pub fn decoder_delay(&self) -> u32 {
        DECODER_DELAY as u32
    }

    #[napi]
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// Push one chunk of s16le PCM and return every complete MP3 packet
    /// it produced (possibly empty — the encoder buffers up to one
    /// frame). `left` / `right` are the raw bytes of the caller's
    /// `Int16Array`s; `right` is `None` for mono, and for stereo a
    /// `None` `right` means `left` is already interleaved s16le.
    #[napi]
    pub fn encode(&mut self, left: BufferSlice, right: Option<BufferSlice>) -> Result<Buffer> {
        let right_ref = right.as_deref();
        self.push_pcm(&left, right_ref)?;
        Ok(Buffer::from(self.drain_packets()?))
    }

    /// Encode into a caller-provided output buffer. Returns bytes
    /// written. No `Buffer` is allocated per chunk — the hot path for a
    /// server encoding many streams. `out` must be large enough for the
    /// packets this chunk produces; the error names the bytes needed.
    #[napi]
    pub fn encode_into(
        &mut self,
        left: BufferSlice,
        right: Option<BufferSlice>,
        mut out: BufferSlice,
    ) -> Result<u32> {
        let right_ref = right.as_deref();
        self.push_pcm(&left, right_ref)?;
        self.drain_to_scratch()?;
        if self.drain_scratch.len() > out.len() {
            return Err(bad_arg(&format!(
                "output buffer too small: need {} bytes for this chunk's MP3 packets, got {}",
                self.drain_scratch.len(),
                out.len()
            )));
        }
        let n = self.drain_scratch.len();
        out[..n].copy_from_slice(&self.drain_scratch);
        Ok(n as u32)
    }

    /// End of input: pad the tail, assemble the bit reservoir, complete
    /// the Info/Xing tag, and return every remaining packet. Idempotent
    /// — a second call returns an empty `Buffer`.
    #[napi]
    pub fn flush(&mut self) -> Result<Buffer> {
        if self.finished {
            return Ok(Buffer::from(vec![]));
        }
        self.encoder.finish();
        self.finished = true;
        Ok(Buffer::from(self.drain_packets()?))
    }

    /// `flush()` into a caller-provided output buffer. Returns bytes
    /// written; see `encode_into` for the size rule.
    #[napi]
    pub fn flush_into(&mut self, mut out: BufferSlice) -> Result<u32> {
        if self.finished {
            return Ok(0);
        }
        self.encoder.finish();
        self.finished = true;
        self.drain_to_scratch()?;
        if self.drain_scratch.len() > out.len() {
            return Err(bad_arg(&format!(
                "output buffer too small: need {} bytes for the flushed MP3 tail, got {}",
                self.drain_scratch.len(),
                out.len()
            )));
        }
        let n = self.drain_scratch.len();
        out[..n].copy_from_slice(&self.drain_scratch);
        Ok(n as u32)
    }
}

/// JS entry point for creating an encoder: `createMp3({ channels,
/// sampleRate, bitrateKbps, vbrQualityIndex })`. A free function (not a
/// class constructor) so construction errors surface as a JS exception
/// instead of a panic.
#[napi]
pub fn create_mp3(opts: Mp3Options) -> Result<NativeMp3> {
    NativeMp3::new(&opts)
}

/// If `bytes` opens (after any ID3/garbage) with an MP3 frame carrying
/// a Xing/Info tag, return the byte offset just past that frame.
///
/// Why: `rusty_mp3`'s encoder leads every stream with a LAME-style
/// Info/Xing tag frame, and its decoder decodes that frame as a full
/// frame of silence. A tag-aware player skips the tag frame and trims
/// only the 528 + 529 codec delay; a naive decoder is shifted by one
/// extra frame (1152 samples) on top of that. This decoder is
/// tag-aware: it drops the tag frame before pushing, so a round trip
/// through our own encoder lines up at exactly
/// `ENCODER_DELAY + DECODER_DELAY` (1057). Streams without a tag
/// (e.g. lamejs output) are untouched — `0` is returned and nothing
/// is skipped. Any parse doubt also returns `0` (safe fallback: the
/// tag frame decodes as silence, as before).
fn skip_xing_tag_frame(bytes: &[u8]) -> usize {
    use rusty_mp3::header::FrameHeader;
    let mut pos = 0;
    while pos + 4 <= bytes.len() {
        if bytes[pos] != 0xFF || bytes[pos + 1] & 0xE0 != 0xE0 {
            pos += 1;
            continue;
        }
        let Ok(header) =
            FrameHeader::parse([bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]])
        else {
            pos += 1;
            continue;
        };
        let frame_size = header.frame_size();
        if frame_size < 4 || pos + frame_size > bytes.len() {
            return 0;
        }
        let xing_at = pos + 4 + usize::from(header.crc_protected) * 2 + header.side_info_len();
        if xing_at + 4 <= pos + frame_size
            && (&bytes[xing_at..xing_at + 4] == b"Xing" || &bytes[xing_at..xing_at + 4] == b"Info")
        {
            return pos + frame_size;
        }
        return 0;
    }
    0
}

/// Decode a whole MP3 byte slice in one call: push, flush, drain to EOF.
/// Returns `{ sampleRate, channels, pcm }` where `pcm` is interleaved
/// s16le bytes (`asFloat = false`) or f32le bytes (`asFloat = true`).
/// An empty input decodes to `{ sampleRate: 0, channels: 0, pcm: [] }`.
/// A stream whose frames disagree on sample rate / channels is an error
/// rather than silently mixed output. A leading Xing/Info tag frame is
/// skipped (see `skip_xing_tag_frame`).
#[napi]
pub fn decode_all(bytes: BufferSlice, as_float: bool) -> Result<DecodedPcm> {
    if bytes.is_empty() {
        return Ok(DecodedPcm {
            sample_rate: 0,
            channels: 0,
            pcm: Buffer::from(vec![]),
        });
    }
    let mut decoder = Mp3Decoder::new();
    decoder.push(&bytes[skip_xing_tag_frame(&bytes)..]);
    decoder.flush();
    let mut sample_rate: u32 = 0;
    let mut channels: u16 = 0;
    let mut pcm: Vec<u8> = Vec::new();
    loop {
        match decoder.next_frame() {
            Ok(frame) => {
                if sample_rate == 0 {
                    sample_rate = frame.sample_rate;
                    channels = frame.channels;
                } else if frame.sample_rate != sample_rate || frame.channels != channels {
                    return Err(bad_arg(&format!(
                        "mixed MP3 stream: frame is {} Hz / {} channels, stream started at {} Hz / {} channels",
                        frame.sample_rate, frame.channels, sample_rate, channels
                    )));
                }
                if as_float {
                    for &v in &frame.samples {
                        pcm.extend_from_slice(&v.to_le_bytes());
                    }
                } else {
                    for &v in &frame.samples {
                        pcm.extend_from_slice(&f32_to_i16(v).to_le_bytes());
                    }
                }
            }
            Err(e) if is_again_or_eof(&e) => break,
            Err(e) => return Err(map_err(e)),
        }
    }
    Ok(DecodedPcm {
        sample_rate,
        channels: channels as u32,
        pcm: Buffer::from(pcm),
    })
}

/// Encoder delay, in samples per channel (528) — the value the
/// Info/Xing tag records and a decoder must trim.
#[napi]
pub fn encoder_delay() -> u32 {
    ENCODER_DELAY as u32
}

/// Decoder delay, in samples per channel (529).
#[napi]
pub fn decoder_delay() -> u32 {
    DECODER_DELAY as u32
}

/// Samples per MP3 frame for a sample rate (1152 MPEG-1, 576 MPEG-2/2.5).
#[napi]
pub fn samples_per_frame(sample_rate: u32) -> Result<u32> {
    if SUPPORTED_SAMPLE_RATES.contains(&sample_rate) {
        Ok(samples_per_frame_for(sample_rate))
    } else {
        Err(bad_arg(
            "sample rate must be one of 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000 Hz",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusty_mp3::{Mp3Decoder, Mp3Encoder, Mp3EncoderConfig};

    fn sine_i16(n: usize, freq: f64, rate: f64) -> Vec<i16> {
        (0..n)
            .map(|i| {
                (0.5 * (2.0 * std::f64::consts::PI * freq * i as f64 / rate).sin() * 32767.0) as i16
            })
            .collect()
    }

    #[test]
    fn samples_per_frame_table() {
        assert_eq!(samples_per_frame_for(44100), 1152);
        assert_eq!(samples_per_frame_for(48000), 1152);
        assert_eq!(samples_per_frame_for(32000), 1152);
        assert_eq!(samples_per_frame_for(22050), 576);
        assert_eq!(samples_per_frame_for(8000), 576);
    }

    #[test]
    fn delays_match_crate_constants() {
        assert_eq!(ENCODER_DELAY, 528);
        assert_eq!(DECODER_DELAY, 529);
    }

    #[test]
    fn f32_to_i16_edges() {
        assert_eq!(f32_to_i16(0.0), 0);
        assert_eq!(f32_to_i16(1.0), 32767);
        assert_eq!(f32_to_i16(-1.0), -32767);
        assert_eq!(f32_to_i16(2.0), 32767);
        assert_eq!(f32_to_i16(-2.0), -32767);
        assert_eq!(f32_to_i16(0.5), 16384);
    }

    #[test]
    fn interleave_matches_manual() {
        // NOTE: tests in this module must not touch napi types
        // (`NativeMp3`, `NapiError`, ...): a cdylib's test binary has no
        // Node runtime to resolve the napi_* symbols, so the link fails
        // with undefined `napi_reference_unref` etc. (bun-rusty-opus hit
        // the same wall — its Rust tests only cover pure helpers.) The
        // napi surface is covered by the JS tests instead.
        let left: Vec<i16> = vec![1, 2, 3];
        let right: Vec<i16> = vec![10, 20, 30];
        let lb: Vec<u8> = left.iter().flat_map(|v| v.to_le_bytes()).collect();
        let rb: Vec<u8> = right.iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut out = vec![0i16; 6];
        interleave_s16le(&lb, &rb, &mut out);
        assert_eq!(out, vec![1, 10, 2, 20, 3, 30]);
    }

    #[test]
    fn xing_tag_frame_is_detected_and_skipped() {
        // Encode a short stream with the crate, then check the tag skip
        // finds exactly the first frame. (decode_all itself is napi, so
        // it is covered by the JS tests; this covers the pure helper.)
        let rate = 44100u32;
        let input = sine_i16(1152 * 2, 440.0, rate as f64);
        let mut enc = Mp3Encoder::new(Mp3EncoderConfig {
            bitrate_kbps: 128,
            vbr_quality: None,
        });
        enc.push_pcm_s16(&input, 1, rate).unwrap();
        enc.finish();
        let mut mp3 = Vec::new();
        loop {
            match enc.next_packet() {
                Ok(p) => mp3.extend_from_slice(&p),
                Err(e) if is_again_or_eof(&e) => break,
                Err(e) => panic!("encode: {e}"),
            }
        }
        let skip = skip_xing_tag_frame(&mp3);
        assert!(skip > 0, "tag frame not detected in our own output");
        // The byte after the skipped frame is the next frame's sync.
        assert_eq!(mp3[skip], 0xFF);
        assert_eq!(mp3[skip + 1] & 0xE0, 0xE0);
        // Untouched data has no tag frame to skip.
        assert_eq!(skip_xing_tag_frame(&mp3[skip..]), 0);
        assert_eq!(skip_xing_tag_frame(&[]), 0);
        assert_eq!(skip_xing_tag_frame(b"not mp3 at all"), 0);
    }

    #[test]
    fn crate_round_trip_sine() {
        // Direct crate-level check (no napi): encode 1 s of 440 Hz mono,
        // decode it, trim the 528 + 529 delay, and check the RMS is close
        // to the input's. This is the same shape the JS round-trip tests
        // assert, at the Rust level.
        let rate = 44100u32;
        let input = sine_i16(rate as usize, 440.0, rate as f64);
        let mut enc = Mp3Encoder::new(Mp3EncoderConfig {
            bitrate_kbps: 128,
            vbr_quality: None,
        });
        enc.push_pcm_s16(&input, 1, rate).unwrap();
        enc.finish();
        let mut mp3 = Vec::new();
        loop {
            match enc.next_packet() {
                Ok(p) => mp3.extend_from_slice(&p),
                Err(e) if is_again_or_eof(&e) => break,
                Err(e) => panic!("encode: {e}"),
            }
        }
        assert!(!mp3.is_empty());
        // First frame must be an MP3 frame sync (0xFF, top 3 bits set).
        assert_eq!(mp3[0], 0xFF);
        assert_eq!(mp3[1] & 0xE0, 0xE0);

        let mut dec = Mp3Decoder::new();
        dec.push(&mp3);
        dec.flush();
        let mut out: Vec<f32> = Vec::new();
        loop {
            match dec.next_frame() {
                Ok(f) => {
                    assert_eq!(f.sample_rate, rate);
                    assert_eq!(f.channels, 1);
                    out.extend_from_slice(&f.samples);
                }
                Err(e) if is_again_or_eof(&e) => break,
                Err(e) => panic!("decode: {e}"),
            }
        }
        // Trim encoder + decoder delay, compare RMS over the overlap.
        let skip = ENCODER_DELAY + DECODER_DELAY;
        let n = input.len().min(out.len().saturating_sub(skip));
        assert!(n > rate as usize / 2, "decoded too short: {n}");
        let in_rms = (input[..n]
            .iter()
            .map(|&v| (v as f64 / 32768.0).powi(2))
            .sum::<f64>()
            / n as f64)
            .sqrt();
        let out_rms = (out[skip..skip + n]
            .iter()
            .map(|&v| (v as f64).powi(2))
            .sum::<f64>()
            / n as f64)
            .sqrt();
        let ratio = out_rms / in_rms;
        assert!(
            (0.7..1.3).contains(&ratio),
            "round-trip RMS ratio {ratio:.3} (in {in_rms:.4}, out {out_rms:.4})"
        );
    }
}
