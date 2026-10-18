import type { BrowserTabActor } from "@ace/protocol";

/**
 * How long after the person last used an agent's tab it stays past the agent's turn: they
 * may still be reading what the agent left there.
 */
export const keepAfterPersonMs = 10 * 60_000;

/** What decides whether a finished agent's tab closes. */
export interface TurnEndTab {
  tabId: string;
  openedBy?: BrowserTabActor | undefined;
  /** The agent marked it a deliverable or handoff. */
  kept: boolean;
  /** The person keeps agents out of it. */
  private: boolean;
  /** The person is looking at it. */
  viewed: boolean;
  /** Commands are queued or running on it. */
  busy: boolean;
  /** A dialog or a download in progress holds it. */
  pinned: boolean;
  /** The person used it within `keepAfterPersonMs`. */
  usedByPerson: boolean;
}

/**
 * The temporary tabs `agentId` opened, which close now that its turn ended (Codex-style:
 * agent tabs are scratch unless kept). Pure. A tab the person opened is never one of them,
 * nor one they view, used lately or made private, nor one still busy or pinned.
 */
export function temporaryTabs(tabs: readonly TurnEndTab[], agentId: string): string[] {
  return tabs
    .filter(
      (tab) =>
        tab.openedBy?.kind === "agent" &&
        tab.openedBy.agentId === agentId &&
        !tab.kept &&
        !tab.private &&
        !tab.viewed &&
        !tab.busy &&
        !tab.pinned &&
        !tab.usedByPerson,
    )
    .map((tab) => tab.tabId);
}
