// Media element helpers.

/** Let go of everything an <audio>/<video> holds. Unmounting the element is
 *  not enough: WebKit keeps the decoded source (and a blob: URL's backing
 *  buffer) alive for as long as the detached element lingers — with a whole
 *  WAV in a blob, that was the webview's memory climbing per opened record.
 *  Clearing `src` and calling load() is the spec's way to empty the element.
 *  Never throws: this runs from ref cleanups, where an exception would abort
 *  the commit. */
export function releaseMedia(el: HTMLMediaElement): void {
  try {
    el.pause();
    el.removeAttribute("src");
    el.load();
  } catch {
    // A half-torn-down element has nothing left worth releasing.
  }
}
