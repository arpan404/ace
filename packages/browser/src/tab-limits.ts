import type { BrowserTabActor } from "@ace/protocol";

/** Live tabs one thread's browser may hold, popups included (ADR 0083). */
export const threadTabLimit = 16;
/** Tabs one agent may have open at once in a thread. */
export const agentTabLimit = 8;
/** Live tabs across every thread in this daemon. */
export const daemonTabLimit = 48;

export type TabOpenRefusal = "thread" | "agent";

/**
 * Whether `opener` may open one more tab beside `tabs`. Pure: the daemon-wide limit is a
 * reservation the backend takes when it creates the target.
 */
export function tabOpenRefusal(
  tabs: readonly { openedBy?: BrowserTabActor | undefined }[],
  opener: BrowserTabActor,
  limits: { thread: number; agent: number } = { thread: threadTabLimit, agent: agentTabLimit },
): TabOpenRefusal | undefined {
  if (tabs.length >= limits.thread) return "thread";
  if (opener.kind !== "agent") return undefined;
  const own = tabs.filter(
    (tab) => tab.openedBy?.kind === "agent" && tab.openedBy.agentId === opener.agentId,
  ).length;
  return own >= limits.agent ? "agent" : undefined;
}
