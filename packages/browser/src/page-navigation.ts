import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
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
export async function traverseHistory(
  cdp: BrowserCdp,
  direction: "back" | "forward" | "reload" | "stop",
  check: () => void,
) {
  if (direction === "stop") {
    check();
    await cdp.send("Page.stopLoading");
    return { ok: true };
  }
  if (direction === "reload") {
    check();
    await cdp.send("Page.reload");
    return { ok: true };
  }
  const state = History.parse(await cdp.send("Page.getNavigationHistory"));
  const entry = state.entries[state.currentIndex + (direction === "back" ? -1 : 1)];
  check();
  if (entry) await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  return { ok: true };
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
