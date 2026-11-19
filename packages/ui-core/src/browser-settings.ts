/*
 * Settings › Browser's words, shared by the web page, the browser's ⋯ menu and the phone so a
 * choice reads the same everywhere: where a thread's pages run, what new browsers keep, which
 * threads share a profile, and what happens when the desktop app goes away.
 */

export const browserEngineChoices = [
  { value: "auto", label: "App, then ace's Chrome" },
  { value: "embedded", label: "Desktop app only" },
  { value: "headless", label: "ace's Chrome only" },
] as const;
export type BrowserEngineChoice = (typeof browserEngineChoices)[number]["value"];
export const browserEngineLabel = (value: string | undefined) =>
  browserEngineChoices.find((choice) => choice.value === value)?.label;

export const browserProfileChoices = [
  { value: "persistent", label: "Keep sign-ins" },
  { value: "ephemeral", label: "Private" },
] as const;
export const browserProfileScopeChoices = [
  { value: "global", label: "Global" },
  { value: "project", label: "Each project" },
  { value: "thread", label: "Each thread" },
] as const;
export const browserLossChoices = [
  { value: "pause", label: "Pause" },
  { value: "headless", label: "Use ace's Chrome" },
] as const;

/** Where ace's Chrome saves downloads on a machine, for its folder setting's description. */
export function browserDownloadsNote(machineDownloads: string): string {
  return machineDownloads
    ? "Empty uses this machine's Downloads folder."
    : "No usable Downloads folder here; empty keeps them with each thread.";
}
