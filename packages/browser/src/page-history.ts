import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import type { NavigationClock } from "./navigation.ts";

/** `Page.getNavigationHistory`: the tab's session history and where the page is in it. */
export const NavigationHistory = z.object({
  currentIndex: z.number().int(),
  entries: z.array(
    z.object({ id: z.number().int(), url: z.string(), title: z.string().optional() }),
  ),
});
export type NavigationHistory = z.infer<typeof NavigationHistory>;
type HistoryEntry = NavigationHistory["entries"][number];

const blank = (url: string) => url === "" || url === "about:blank";

/**
 * The entries Back and Forward lead to, if any. The blank page a tab opened on (and any blank
 * entries before its first real page) is no page to go back to: a new tab can't go Back.
 */
export function historySteps(history: NavigationHistory): {
  back: HistoryEntry | undefined;
  forward: HistoryEntry | undefined;
} {
  const { currentIndex: index, entries } = history;
  const first = entries.findIndex((entry) => !blank(entry.url));
  return {
    back: first >= 0 && index - 1 >= first ? entries[index - 1] : undefined,
    forward: index >= 0 ? entries[index + 1] : undefined,
  };
}

/**
 * How long after a navigation the history is read once more. An engine may report a
 * navigation (an SPA's `pushState` above all) a moment before its new entry exists.
 */
export const historySettleMs = 300;
/** Every way a tab's history changes: a document commits, or a page moves within itself. */
const changes = ["Page.frameNavigated", "Page.navigatedWithinDocument"] as const;
const nothing = () => {};

/**
 * Whether a tab can go Back and Forward, kept current: the history is read again on every
 * navigation, in-page ones included, and once more shortly after. The reads go straight to the
 * page's session, never through the tab's command queue, so slow work or a dialog in the tab
 * can't hold them up. Works the same in every engine: it is plain CDP on the tab's own page.
 */
export class PageHistory {
  private flags: { back: boolean; forward: boolean } | undefined;
  private stop = () => {};
  private changed: () => void;
  private clock: NavigationClock;
  constructor(changed: () => void, clock: NavigationClock) {
    this.changed = changed;
    this.clock = clock;
  }
  /** Undefined until the history has been read. */
  get canGoBack(): boolean | undefined {
    return this.flags?.back;
  }
  get canGoForward(): boolean | undefined {
    return this.flags?.forward;
  }
  /** Follow the history on the session that reaches the page now (again after a replacement). */
  watch(cdp: BrowserCdp): void {
    this.stop();
    this.flags = undefined;
    let stopped = false;
    let reading = false;
    let again = false;
    let cancelSettle = nothing;
    const read = () => {
      if (stopped) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      void cdp
        .send("Page.getNavigationHistory")
        .then(
          (raw) => {
            const history = NavigationHistory.safeParse(raw);
            if (!stopped && history.success) this.set(historySteps(history.data));
          },
          // A page that can't answer now keeps its last answer; the next navigation asks again.
          () => {},
        )
        .finally(() => {
          reading = false;
          if (!again) return;
          again = false;
          read();
        });
    };
    const navigated = () => {
      read();
      cancelSettle();
      cancelSettle = this.clock.set(historySettleMs, read);
    };
    for (const method of changes) cdp.on(method, navigated);
    this.stop = () => {
      stopped = true;
      cancelSettle();
      for (const method of changes) cdp.off(method, navigated);
    };
    read();
  }
  close(): void {
    this.stop();
    this.stop = () => {};
  }
  private set(steps: ReturnType<typeof historySteps>): void {
    const next = { back: steps.back !== undefined, forward: steps.forward !== undefined };
    if (next.back === this.flags?.back && next.forward === this.flags.forward) return;
    this.flags = next;
    this.changed();
  }
}
