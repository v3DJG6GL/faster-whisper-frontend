// Test support shared by the transcript suites.
import type { BatchResult } from "../types";

/** One segment holding `text`, its words `ws` timed 0.5 s apiece from 0. */
export const wordLine = (text: string, ws: string[], language?: string): BatchResult => ({
  text,
  ...(language ? { language } : {}),
  segments: [{ start: 0, end: ws.length * 0.5, text }],
  words: ws.map((word, i) => ({ word, start: i * 0.5, end: i * 0.5 + 0.5 })),
});
