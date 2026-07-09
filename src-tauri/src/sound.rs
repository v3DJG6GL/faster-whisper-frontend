//! Short, synthesised audio cues for dictation start / stop / error.
//!
//! Played from Rust (not the WebView): dictation is usually triggered by a global
//! hotkey, which carries no DOM user-gesture, so WebView audio would be blocked by
//! the autoplay policy. Tones are built sample-by-sample with a soft attack +
//! exponential-decay envelope (no hard on/off → no click) and a light second
//! harmonic for a gentle "bell" timbre — a flat-envelope sine cut abruptly was the
//! source of the harsh "beep". Cues are two-tone: rising for start, falling for
//! stop, low/falling for error. The "Sound effects" setting is checked on the
//! frontend before this command is invoked.

const SAMPLE_RATE: u32 = 48_000;
const ATTACK_MS: f32 = 10.0;

/// One note in a cue: frequency (Hz), duration (ms), peak amplitude (0..1).
struct Note {
    freq: f32,
    ms: u32,
    amp: f32,
}

/// Render a sequence of notes to mono f32 samples. Each note ramps up over a short
/// attack then decays exponentially to ~silence, so notes butt together cleanly
/// (each starts and ends near zero — no discontinuity/click).
fn render(notes: &[Note]) -> Vec<f32> {
    let sr = SAMPLE_RATE as f32;
    let mut out = Vec::new();
    for note in notes {
        let n = (sr * note.ms as f32 / 1000.0) as usize;
        if n == 0 {
            continue;
        }
        let attack = ((sr * ATTACK_MS / 1000.0) as usize).clamp(1, n.saturating_sub(1).max(1));
        for i in 0..n {
            let t = i as f32 / sr;
            let env = if i < attack {
                i as f32 / attack as f32
            } else {
                // exponential decay reaching ~0.001 by the end of the note
                let k = (i - attack) as f32 / (n - attack).max(1) as f32;
                (-6.9 * k).exp()
            };
            // fundamental + light 2nd harmonic, normalised so the peak stays ~amp
            let w = (std::f32::consts::TAU * note.freq * t).sin()
                + 0.18 * (std::f32::consts::TAU * note.freq * 2.0 * t).sin();
            out.push(env * note.amp * w / 1.18);
        }
    }
    out
}

/// Play a one-shot cue. `kind` is "start" | "stop" | "error" (anything else is a
/// no-op). Returns immediately; the tone plays on a detached thread.
#[tauri::command]
pub fn play_cue(kind: String) {
    let notes: &[Note] = match kind.as_str() {
        // rising perfect fifth — "listening"
        "start" => &[
            Note { freq: 523.25, ms: 120, amp: 0.20 },
            Note { freq: 783.99, ms: 150, amp: 0.20 },
        ],
        // falling fifth — mirror of start
        "stop" => &[
            Note { freq: 783.99, ms: 120, amp: 0.18 },
            Note { freq: 523.25, ms: 170, amp: 0.18 },
        ],
        // low, gently dissonant fall — error (no piercing 2–4 kHz content)
        "error" => &[
            Note { freq: 440.00, ms: 150, amp: 0.24 },
            Note { freq: 349.23, ms: 220, amp: 0.24 },
        ],
        _ => return,
    };
    let samples = render(notes);
    std::thread::spawn(move || {
        // Keep `sink` (it owns the device stream) alive until the tone
        // finishes — dropping it cuts audio.
        let Ok(sink) = rodio::DeviceSinkBuilder::open_default_sink() else {
            return;
        };
        let player = rodio::Player::connect_new(sink.mixer());
        player.append(rodio::buffer::SamplesBuffer::new(
            std::num::NonZero::new(1).unwrap(), // mono
            std::num::NonZero::new(SAMPLE_RATE).unwrap(),
            samples,
        ));
        player.sleep_until_end();
    });
}
