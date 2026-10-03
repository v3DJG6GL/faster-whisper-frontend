//! Which raw ALSA capture paths the advanced picker offers, and what each one does.
//!
//! ALSA lists every PCM name a card can be opened under, and they all carry the same description,
//! which is why the old picker showed each microphone five or six times. Only four kinds are worth
//! offering, each with a different trade-off; everything else is either a duplicate under another
//! name (`hw:2` = `hw:CARD=USB`), not a capture path for a microphone (`front:`, `usbstream:`,
//! `iec958:` …) or a plugin that routes back into the sound server or nowhere.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PathKind {
    /// `sysdefault:` — shared through dmix/dsnoop, converts format.
    Shared,
    /// `plughw:` — exclusive, converts format.
    Exclusive,
    /// `hw:` — exclusive, raw hardware formats only.
    Raw,
    /// `dsnoop:` — shared, no conversion.
    Dsnoop,
}

/// The kind of an ALSA PCM id and the card it belongs to (`CARD=` value), or None for a path the
/// picker never shows.
pub fn classify(pcm_id: &str) -> Option<(PathKind, String)> {
    let (prefix, args) = pcm_id.split_once(':')?;
    let kind = match prefix {
        "sysdefault" => PathKind::Shared,
        "plughw" => PathKind::Exclusive,
        "hw" => PathKind::Raw,
        "dsnoop" => PathKind::Dsnoop,
        _ => return None,
    };
    let card = args
        .split(',')
        .find_map(|kv| kv.strip_prefix("CARD="))
        .filter(|c| !c.is_empty())?;
    // `hw:CARD=2,DEV=0` is cpal's numeric twin of `hw:CARD=USB,DEV=0`: hide it.
    if card.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((kind, card.to_string()))
}

/// The card part of an ALSA description line ("RØDE PodMic USB, USB Audio" → "RØDE PodMic USB").
pub fn card_label(description: &str) -> &str {
    let first = description.lines().next().unwrap_or(description);
    first
        .split_once(", ")
        .map_or(first, |(card, _)| card)
        .trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_four_offered_kinds() {
        assert_eq!(
            classify("sysdefault:CARD=USB"),
            Some((PathKind::Shared, "USB".into()))
        );
        assert_eq!(
            classify("plughw:CARD=USB,DEV=0"),
            Some((PathKind::Exclusive, "USB".into()))
        );
        assert_eq!(
            classify("hw:CARD=C920,DEV=0"),
            Some((PathKind::Raw, "C920".into()))
        );
        assert_eq!(
            classify("dsnoop:CARD=USB,DEV=0"),
            Some((PathKind::Dsnoop, "USB".into()))
        );
    }

    #[test]
    fn hidden_paths() {
        for id in [
            "front:CARD=USB,DEV=0",
            "usbstream:CARD=USB",
            "iec958:CARD=PCH,DEV=0",
            "surround51:CARD=PCH,DEV=0",
            "hdmi:CARD=PCH,DEV=0",
            "hw:CARD=2,DEV=0",
            "plughw:CARD=2,DEV=0",
            "default",
            "pipewire",
            "pulse",
            "null",
            "jack",
            "oss",
            "speex",
            "upmix",
            "vdownmix",
            "samplerate",
            "speexrate",
            "lavrate",
            "dmix:CARD=USB,DEV=0",
            "hw:",
        ] {
            assert_eq!(classify(id), None, "{id} must stay hidden");
        }
    }

    #[test]
    fn card_label_takes_the_card_part_of_the_first_line() {
        assert_eq!(
            card_label(
                "RØDE PodMic USB, USB Audio\nDirect hardware device without any conversions"
            ),
            "RØDE PodMic USB"
        );
        assert_eq!(card_label("HD Pro Webcam C920"), "HD Pro Webcam C920");
    }
}
