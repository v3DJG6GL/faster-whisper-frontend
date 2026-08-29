//! Last-resort playback decode. Linux WebKitGTK without the proprietary
//! GStreamer plugin set cannot play AAC/MP4 — the format yt-dlp's `bestaudio`
//! picks — and feeding the same bytes back as a blob doesn't change that.
//! Symphonia decodes the file in-process (pure Rust, no system codecs) and
//! the viewer plays a plain PCM WAV blob instead. Fallback-path only: the
//! `<audio>` element gets two chances at the original bytes first.

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error as SymErr;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

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
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| format!("unrecognized container: {e}"))?;
    let (track_id, params) = format
        .tracks()
        .iter()
        .find_map(|t| match &t.codec_params {
            Some(CodecParameters::Audio(p)) => Some((t.id, p.clone())),
            _ => None,
        })
        .ok_or("no audio track")?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;

    let mut sample_rate: u32 = params.sample_rate.unwrap_or(44_100);
    let mut channels: u16 = params
        .channels
        .as_ref()
        .map(|c| c.count() as u16)
        .unwrap_or(2);
    let mut pcm: Vec<u8> = Vec::new();
    let mut interleaved: Vec<i16> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            // End of stream; ResetRequired only occurs mid-chained-stream —
            // treat both as "done" for a finite local file.
            Ok(None) | Err(SymErr::ResetRequired) => break,
            Err(e) => return Err(format!("read failed: {e}")),
        };
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // A corrupt frame mid-file is survivable — skip it.
            Err(SymErr::DecodeError(_)) => continue,
            Err(e) => return Err(format!("decode failed: {e}")),
        };
        let spec = decoded.spec();
        sample_rate = spec.rate();
        channels = spec.channels().count() as u16;
        decoded.copy_to_vec_interleaved::<i16>(&mut interleaved);
        for s in &interleaved {
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
