// The short description under each setting row that is titled by its server ENV name: the
// backend's own wording (approved with the settings-batch mockup, 2026-10-05). One table, so a
// row on Profiles, Backends and Transcribe can't describe the same setting two ways.

import { hasOwn } from "./own";

export const ENV_DESC: Readonly<Record<string, string>> = {
  APPEND_PUNCTUATIONS: "With WORD_TIMESTAMPS_ENABLED, glue these characters onto the PRECEDING word's timing.",
  BEAM_SIZE: "Beam size to use for decoding.",
  BEST_OF: "Sample trajectories per fallback retry (temperature > 0).",
  CAPTURES_RECORDING_ENABLED: "Master switch for capturing audio + word-timestamps next to each transcription, for use as Whisper fine-tuning training data.",
  CAPTURES_RECORDING_SAMPLE_RATE: "Fraction of eligible transcription requests to capture (0.0–1.0).",
  CAPTURES_RETENTION_DAYS: "Auto-delete captures older than this many days.",
  COMPRESSION_RATIO_THRESHOLD: "Above this text compression ratio, the decode is treated as failed.",
  CONDITION_ON_PREVIOUS_TEXT: "Feed the previous window’s text to the next one as a prompt.",
  DEFAULT_HOTWORDS: "Vocabulary bias re-injected into every decoder window.",
  DEFAULT_LANGUAGE: "Language code such as 'en' or 'de'.",
  DEFAULT_MODEL: "Model loaded when a request sends 'whisper-1' or omits 'model'.",
  DEFAULT_PROMPT: "Initial prompt for the first window, e.g. proper nouns and vocabulary.",
  HALLUCINATION_SILENCE_THRESHOLD: "Skip silent stretches longer than this many seconds when a hallucination is suspected.",
  LANGUAGE_DETECTION_SEGMENTS: "How many leading 30 s chunks to sample for language detection.",
  LANGUAGE_DETECTION_THRESHOLD: "Min probability the top language must reach for detection to be accepted.",
  LENGTH_PENALTY: "Beam-scoring length-norm exponent.",
  LOG_BACKUP_COUNT: "Number of rotated log files to retain.",
  LOG_MAX_BYTES: "Rotate the log file when it reaches this size in bytes.",
  LOG_PROB_THRESHOLD: "Treat a decode as failed below this average log-probability.",
  NO_REPEAT_NGRAM_SIZE: "Hard ban on n-grams of this size repeating.",
  NO_SPEECH_THRESHOLD: "Drop a segment as silent when its no-speech probability is above this value.",
  OUTPUT_PREFIX: "Plain text prepended to the final transcript.",
  OUTPUT_SUFFIX: "Plain text appended to the final transcript.",
  PATIENCE: "Beam-search patience factor; >1 keeps the beam alive longer.",
  PREPEND_PUNCTUATIONS: "With WORD_TIMESTAMPS_ENABLED, glue these characters onto the FOLLOWING word's timing.",
  RECENT_TRANSCRIPTIONS_MAX: "Hard row-count cap. 0 = unbounded.",
  RECENT_TRANSCRIPTIONS_RETENTION_DAYS: "Auto-delete entries older than this many days.",
  REPETITION_PENALTY: "Multiplies logit of already-emitted tokens by 1/penalty.",
  STREAMING_HARD_BREAK_SEPARATOR: "Text typed between documents at a hard break.",
  STREAMING_HARD_BREAK_SILENCE_MS: "Silence that starts a fresh document, so a pause acts as a paragraph break. 0 = off.",
  STREAMING_VAD_INNER_SILENCE_MS: "A pause this long refreshes the live preview without finalizing. Keep it below the outer silence.",
  STREAMING_VAD_OUTER_SILENCE_MS: "End-of-speech silence that finalizes the utterance.",
  STREAMING_VAD_THRESHOLD: "Speech-probability cutoff (0–1). Lower for quiet speakers.",
  SUPPRESS_CHARS: "Single characters the decoder may not emit.",
  SUPPRESS_TOKENS: "Comma-separated token IDs to ban from output. -1 = the model's default set.",
  TEMPERATURE: "Fallback ladder for decoding when quality checks fail.",
  TRANSLATE_TO: "Target languages translated by default.",
  TRANSLATION_CONTEXT_SEGMENTS: "Previous source segments sent as context for each translation batch. 0 = no context.",
  TRANSLATION_GLOSSARY: "Terminology enforced via the prompt: one “source = target” pair per line.",
  TRANSLATION_MAX_TARGETS: "Max target languages one request may ask for.",
  TRANSLATION_MODE: "Fluent merges segments into sentences before translating; faithful keeps them apart.",
  TRANSLATION_MODEL: "Translation model for this request. Empty = the server default.",
  URL_ALLOWED_EXTRACTORS: "Only these extractors may be downloaded. Empty = every dedicated extractor.",
  URL_ALLOW_DIRECT_MEDIA: "Accept direct links to media files.",
  URL_MAX_DURATION_S: "Reject linked media longer than this many seconds.",
  USAGE_APP_RETENTION_DAYS: "Auto-delete the per-app dictation rollup older than this many days.",
  USAGE_RETENTION_DAYS: "Auto-delete hourly usage rollup rows older than this many days. 0 = keep forever.",
  VAD_FILTER: "Filter out parts of the audio without speech (Silero VAD).",
  VAD_MIN_SILENCE_MS: "In the end of each speech chunk, wait this long before separating it.",
  VAD_SPEECH_PAD_MS: "Final speech chunks are padded by this much on each side.",
  VAD_THRESHOLD: "Speech probability above which audio counts as speech.",
};

/** The description of a server setting, or undefined when there is none. */
export function envDesc(env: string): string | undefined {
  return hasOwn(ENV_DESC, env) ? ENV_DESC[env] : undefined;
}
