//! Which cpal host the app records and plays through.
//!
//! One place decides it, so capture, the mic test and the sound cues never disagree about the
//! backend. Windows / macOS: cpal's default (WASAPI / CoreAudio). Linux: ALSA for now.

/// The host every capture and playback path uses.
pub fn app_host() -> cpal::Host {
    #[cfg(target_os = "linux")]
    {
        // cpal 0.18 makes the PulseAudio host the default once its feature is on; stay on ALSA
        // explicitly until the mic picker stores ids that host understands.
        if let Ok(h) = cpal::host_from_id(cpal::HostId::Alsa) {
            return h;
        }
    }
    cpal::default_host()
}
