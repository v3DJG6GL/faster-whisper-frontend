//! Last-resort playback decode. Linux WebKitGTK without the proprietary
//! GStreamer plugin set cannot play AAC/MP4 — exactly the format yt-dlp's
//! `bestaudio` retains for URL transcripts — and feeding the same bytes back
//! as a blob doesn't change that. Symphonia decodes the file in-process
//! (pure Rust, no system codecs) and the viewer plays a plain PCM WAV blob
//! instead. Fallback-path only: the `<audio>` element gets two chances at
//! the original bytes first.

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymErr;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Decoded-PCM ceiling: ~1 h of 44.1 kHz stereo. Blobs beyond that would
/// strain the webview more than help it; the viewer then shows its honest
/// "can't be decoded" note instead.
const MAX_PCM_BYTES: usize = 640 * 1024 * 1024;

/// Decode any symphonia-supported audio file to 16-bit interleaved WAV
/// bytes at the source rate and channel count.
pub fn decode_to_wav(path: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
    {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("unrecognized container: {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("no audio track")?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;

    let mut sample_rate: u32 = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut channels: u16 = track
        .codec_params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or(2);
    let mut pcm: Vec<u8> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // Both are symphonia's "stream over" shapes for finite files.
            Err(SymErr::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymErr::ResetRequired) => break,
            Err(e) => return Err(format!("read failed: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // A corrupt frame mid-file is survivable — skip it.
            Err(SymErr::DecodeError(_)) => continue,
            Err(e) => return Err(format!("decode failed: {e}")),
        };
        let spec = *decoded.spec();
        sample_rate = spec.rate;
        channels = spec.channels.count() as u16;
        let mut buf = SampleBuffer::<i16>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);
        for s in buf.samples() {
            pcm.extend_from_slice(&s.to_le_bytes());
        }
        if pcm.len() > MAX_PCM_BYTES {
            return Err("audio too long to decode for playback".into());
        }
    }
    if pcm.is_empty() {
        return Err("no decodable audio in the file".into());
    }
    Ok(crate::audio::wav_from_pcm16(&pcm, sample_rate, channels))
}
