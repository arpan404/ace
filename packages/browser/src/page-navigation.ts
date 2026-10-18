import { z } from "zod";
import { BrowserActionError } from "./action-error.ts";
import type { BrowserCdp } from "./backend.ts";
import type { NavigationClock } from "./navigation.ts";
const History = z.object({
  currentIndex: z.number().int(),
  entries: z.array(
    z.object({ id: z.number().int(), url: z.string(), title: z.string().optional() }),
  ),
});
const shownEntries = 20;
/** Whether back/forward work, and the session's recent entries with the current one marked. */
export async function pageHistory(cdp: BrowserCdp) {
  const state = History.parse(await cdp.send("Page.getNavigationHistory"));
  const first = Math.max(0, state.entries.length - shownEntries);
  return {
    back: state.currentIndex > 0,
    forward: state.currentIndex < state.entries.length - 1,
    entries: state.entries.slice(first).map((entry, index) => {
      const shown: { url: string; title?: string; current?: true } = {
        url: entry.url.slice(0, 2048),
      };
      if (entry.title) shown.title = entry.title.slice(0, 256);
      if (first + index === state.currentIndex) shown.current = true;
      return shown;
    }),
  };
}
/** Longest a history move waits to learn whether the page let it go. */
export const leaveVerdictMs = 1_000;
/** Signs that a move went ahead: the page started loading, changed, or asked to stay. */
const proceeding = [
  "Page.frameStartedLoading",
  "Page.frameNavigated",
  "Page.navigatedWithinDocument",
  "Page.javascriptDialogOpening",
] as const;

/**
 * Back, forward, reload or stop. A move off a page the person edited fails at once with
 * `unsaved_changes` where the engine keeps the page itself (the desktop's view reports
 * `ace.unloadRefused`), instead of reporting success for a page that never left.
 */
export async function traverseHistory(
  cdp: BrowserCdp,
  direction: "back" | "forward" | "reload" | "stop",
  check: () => void,
  clock: NavigationClock,
) {
  if (direction === "stop") {
    check();
    await cdp.send("Page.stopLoading");
    return { ok: true };
  }
  let move: () => Promise<unknown>;
  if (direction === "reload") move = () => cdp.send("Page.reload");
  else {
    const state = History.parse(await cdp.send("Page.getNavigationHistory"));
    const entry = state.entries[state.currentIndex + (direction === "back" ? -1 : 1)];
    if (!entry) {
      check();
      return { ok: true };
    }
    move = () => cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  }
  const { promise: decided, resolve: verdict } = Promise.withResolvers<boolean>();
  const refused = () => verdict(true);
  const went = () => verdict(false);
  cdp.on("ace.unloadRefused", refused);
  for (const method of proceeding) cdp.on(method, went);
  // No sign either way in time: the move went ahead (an engine that never keeps pages).
  const cancel = clock.set(leaveVerdictMs, went);
  try {
    check();
    await move();
    if (await decided) throw new BrowserActionError("unsaved_changes");
    return { ok: true };
  } finally {
    cancel();
    cdp.off("ace.unloadRefused", refused);
    for (const method of proceeding) cdp.off(method, went);
  }
}
export async function findPageText(cdp: BrowserCdp, text: string, forward: boolean) {
  const result = z.object({ result: z.object({ value: z.boolean().optional() }) }).parse(
    await cdp.send("Runtime.evaluate", {
      expression: text
        ? `window.find(${JSON.stringify(text)},false,${!forward},true,false,true,false)`
        : "(getSelection()?.removeAllRanges(),false)",
      returnByValue: true,
    }),
  );
  return { found: result.result.value ?? false };
}
