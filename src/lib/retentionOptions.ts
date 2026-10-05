/** One `<Select>` option: the persisted day count as a string, and its label. */
export type DayOption = { value: string; label: string };

/**
 * The retention lists a Select offers, plus the current value when it is not
 * among them. A controlled `<select>` whose value matches no option shows the
 * FIRST option — "7 days" or "Keep forever" — while some other clock runs; a
 * value that arrived from an older config, a server pull or an import file
 * can be any integer in 0..3650, so the readout must carry it as-is.
 */
export function withCurrentDay(options: DayOption[], days: number): DayOption[] {
  const v = String(days);
  return options.some((o) => o.value === v)
    ? options
    : [...options, { value: v, label: days === 1 ? "1 day" : `${days} days` }];
}

export const LOG_RETENTION_OPTIONS: DayOption[] = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "0", label: "Keep forever" },
];

export const DICTATION_RETENTION_OPTIONS: DayOption[] = [
  { value: "0", label: "Keep forever" },
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

export const HISTORY_RETENTION_OPTIONS: DayOption[] = [
  { value: "0", label: "Keep forever" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];
