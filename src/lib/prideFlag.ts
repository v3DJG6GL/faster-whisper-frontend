// The Intersex-Inclusive Progress Pride flag (Vecchietti 2021; building on Baker, Helms,
// Quasar & Carpenter), used verbatim across the app's small solidarity touches: the
// hover-revealed flag in the dictation waveform (canvas, via an <img> → CanvasPattern)
// and the sidebar footer mark. Kept here so both surfaces share one source of truth.
//
// width/height are set (not just viewBox) so the SVG has an intrinsic size when loaded
// as an Image for canvas drawImage.

export const PRIDE_FLAG_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="762" viewBox="0 0 1200 762">' +
  '<path fill="#6d2380" d="M0 0h1200v762H0V0Z"/>' +
  '<path fill="#2c58a4" d="M0 0h1200v635H0V0Z"/>' +
  '<path fill="#78b82a" d="M0 0h1200v508H0V0Z"/>' +
  '<path fill="#efe524" d="M0 0h1200v381H0V0Z"/>' +
  '<path fill="#f28917" d="M0 0h1200v254H0V0Z"/>' +
  '<path fill="#e22016" d="M0 0h1200v127H0V0Z"/>' +
  '<path d="M315 0H0v762h315l353-381L315 0z"/>' +
  '<path fill="#945516" d="M241 0H0v762h241l353-381L241 0z"/>' +
  '<path fill="#7bcce5" d="M168 0H0v762h168l353-381L168 0z"/>' +
  '<path fill="#f4aec8" d="M95 0H0v762h95l353-381L95 0z"/>' +
  '<path fill="#ffffff" d="M0 0v762h22l352-381L22 0H0z"/>' +
  '<path fill="#fdd817" d="m0 706 301-325L0 55v651z"/>' +
  '<circle cx="111" cy="381" r="80" fill="none" stroke="#66338b" stroke-width="19"/>' +
  "</svg>";

/** data: URI for use as an <img> src or a canvas Image. */
export const PRIDE_FLAG_URI = `data:image/svg+xml,${encodeURIComponent(PRIDE_FLAG_SVG)}`;

/** The flag's intrinsic aspect (width / height) — for keeping it un-stretched. */
export const PRIDE_FLAG_ASPECT = 1200 / 762;

/** Plain 6-stripe rainbow Pride flag, top→bottom (Gay_Pride_Flag.svg). Used for the
 *  WAVEFORM reveal: it's uniform horizontally, so one vertical gradient fills the whole
 *  meter seamlessly — no tiling, no chevron to duplicate. (The sidebar mark keeps the
 *  fuller Intersex-Inclusive Progress flag above.) */
export const PRIDE_RAINBOW_STOPS = [
  "#E50000", // red
  "#FF8D00", // orange
  "#FFEE00", // yellow
  "#028121", // green
  "#004CFF", // blue
  "#770088", // violet
];
