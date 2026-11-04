/**
 * The words for where a thread's pages run, shared by Settings › Browser and the browser's ⋯
 * menu so a choice reads the same in both places.
 */
export const browserEngineChoices = [
  { value: "auto", label: "App, then ace's Chrome" },
  { value: "embedded", label: "Desktop app only" },
  { value: "headless", label: "ace's Chrome only" },
] as const;

export type BrowserEngineChoice = (typeof browserEngineChoices)[number]["value"];

export const browserEngineLabel = (value: string | undefined) =>
  browserEngineChoices.find((choice) => choice.value === value)?.label;
