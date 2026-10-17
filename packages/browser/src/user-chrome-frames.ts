import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";
import { pageFrames } from "./page-frames.ts";
import { countingDomNodes } from "./user-chrome-dom-counters.ts";
import type { UserTabCdp } from "./user-chrome-link.ts";

const Attached = z.object({
  sessionId: z.string().min(1).max(128),
  targetInfo: z.object({ type: z.string() }),
});
const Detached = z.object({ sessionId: z.string().min(1).max(128) });

/**
 * A tab's out-of-process iframes in the person's browser (ADR 0084). The extension attaches to
 * them as child debugger sessions and relays their events; each becomes its own CDP surface, so
 * snapshots read cross-site frames and refs act inside them as in ace's own browsers.
 */
export function userTabFrames(tab: UserTabCdp) {
  const sessions = new Map<string, BrowserCdp>();
  const attached = (raw: unknown) => {
    const parsed = Attached.safeParse(raw);
    if (!parsed.success || parsed.data.targetInfo.type !== "iframe") return;
    const { sessionId } = parsed.data;
    if (sessions.has(sessionId)) return;
    const session = tab.session(sessionId);
    const child: BrowserCdp = { ...session, send: countingDomNodes(session.send) };
    sessions.set(sessionId, child);
    // A frame inside this one reports its own session here.
    child.on("Target.attachedToTarget", attached);
    child.on("Target.detachedFromTarget", detached);
    void child.send("Page.enable").catch(() => {});
  };
  const detached = (raw: unknown) => {
    const parsed = Detached.safeParse(raw);
    if (!parsed.success || !sessions.delete(parsed.data.sessionId)) return;
    tab.endSession(parsed.data.sessionId);
  };
  tab.on("Target.attachedToTarget", attached);
  tab.on("Target.detachedFromTarget", detached);
  return {
    /** The tab's frames, each with the session that reaches it. */
    list: (main: BrowserCdp) => pageFrames([main, ...sessions.values()]),
    close() {
      tab.off("Target.attachedToTarget", attached);
      tab.off("Target.detachedFromTarget", detached);
      for (const sessionId of sessions.keys()) tab.endSession(sessionId);
      sessions.clear();
    },
  };
}
