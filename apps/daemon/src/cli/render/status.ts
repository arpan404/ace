/** What `ace status` prints from: the daemon's health, plus what it could add. */
export interface StatusView {
  readonly running: boolean;
  readonly version?: string;
  readonly account?: { readonly signedIn: boolean; readonly email?: string | undefined };
  readonly needsYou?: number;
  readonly working?: number;
}

/**
 * Three short lines (ADR 0178 §7): ace runs, who it's signed in as, what needs you and what
 * works. Facts the daemon didn't give are left out, never guessed. Pure.
 */
export function statusLines(view: StatusView): string[] {
  if (!view.running) return ["ace isn't running. Start it with ace start, or open the app."];
  const lines = [`ace is running${view.version ? ` (${view.version})` : ""}.`];
  if (view.account)
    lines.push(
      view.account.signedIn
        ? `Signed in to ace${view.account.email ? ` as ${view.account.email}` : ""}.`
        : "Not signed in to ace. Sign in with ace login.",
    );
  if (view.needsYou !== undefined || view.working !== undefined) {
    const needs = view.needsYou
      ? `${view.needsYou} ${view.needsYou === 1 ? "request needs" : "requests need"} you (ace request list)`
      : "Nothing needs you";
    const works = view.working
      ? `${view.working} ${view.working === 1 ? "thread" : "threads"} working`
      : "nothing working";
    lines.push(`${needs}, ${works}.`);
  }
  return lines;
}
