//! Short, synthesised audio cues for dictation start / stop / error.
//!
//! Played from Rust (not the WebView) on purpose: dictation is usually triggered
//! by a global hotkey, which carries no DOM user-gesture, so WebView audio would
//! be blocked by the browser autoplay policy. A fresh cpal output stream per cue
//! avoids holding the audio device open between dictations. The "Sound effects"
//! setting is checked on the frontend before this command is invoked.

use std::time::Duration;

/// Play a one-shot cue. `kind` is "start" | "stop" | "error" (anything else is a
/// no-op). Returns immediately; the tone plays on a detached thread.
#[tauri::command]
pub fn play_cue(kind: String) {
    let (freq, ms, amp): (f32, u64, f32) = match kind.as_str() {
        "start" => (820.0, 110, 0.16),
        "stop" => (520.0, 110, 0.16),
        "error" => (300.0, 240, 0.18),
        _ => return,
    };
    std::thread::spawn(move || {
        use rodio::Source;
        // Keep `_stream` alive until the tone finishes (dropping it cuts audio).
        let Ok((_stream, handle)) = rodio::OutputStream::try_default() else {
            return;
        };
        let Ok(sink) = rodio::Sink::try_new(&handle) else {
            return;
        };
        let tone = rodio::source::SineWave::new(freq)
            .take_duration(Duration::from_millis(ms))
            .amplify(amp)
            .fade_in(Duration::from_millis(12));
        sink.append(tone);
        sink.sleep_until_end();
    });
}
