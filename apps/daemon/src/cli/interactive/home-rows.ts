import type { ProviderKind, ThreadListEntry } from "@ace/protocol";
import {
  activityOf,
  arrange,
  cardDetails,
  formatAge,
  formatElapsed,
  homeMachine,
  rowStatusLook,
  rowStatusState,
  threadCard,
  type RowStatusIconKind,
  type RowStatusState,
  type RowStatusTone,
} from "@ace/ui-core";

/**
 * The home's rows (ADR 0176 §9): the app's Inbox order (`arrange`) and its status rules
 * (`threadCard` → `rowAttention` → `rowStatusLook`), the same code the app runs, so the terminal
 * never calls a thread done while any part of its tree works or waits on a person. Pure.
 */
export interface HomeRow {
  readonly id: string;
  /** One glyph for the row's state (`◌3` while waiting on three agents); blank when at rest. */
  readonly glyph: string;
  readonly tone: RowStatusTone;
  readonly state: RowStatusState;
  /** The running time while it works, its age at rest, or a word ("Syncing"). */
  readonly time: string;
  /** Its state in words, for the agent tree and the farewell line ("Needs approval"). */
  readonly meaning: string;
  readonly project: string;
  readonly projectId: string;
  readonly title: string;
  readonly branch: string;
  readonly provider: ProviderKind;
  /** It needs the person: a request is open somewhere in its tree. */
  readonly needsYou: boolean;
  /** Something in its tree is running, so Stop has something to stop. */
  readonly running: boolean;
}

export interface HomeRowsInput {
  readonly entries: readonly ThreadListEntry[];
  readonly now: number;
  /** The list is a copy the daemon hasn't confirmed: rows claim no status ("Syncing"). */
  readonly unconfirmed: boolean;
  readonly projectName: (id: string) => string;
}

const glyphs: Record<RowStatusIconKind | "none", string> = {
  approve: "◆",
  question: "?",
  model: "◆",
  failed: "✕",
  working: "◌",
  agents: "◌",
  waiting: "◌",
  background: "▣",
  limited: "◔",
  done: "✓",
  none: " ",
};

export function homeRows(input: HomeRowsInput): HomeRow[] {
  const byId = new Map(input.entries.map((entry) => [entry.id, entry]));
  const order = arrange(input.entries, { project: null }, input.now);
  const home = homeMachine(input.entries);
  const ids = [...order.pinned, ...order.active, ...order.recent];
  return ids.flatMap((id) => {
    const entry = byId.get(id);
    if (!entry) return [];
    const card = threadCard({
      entry,
      details: cardDetails(entry, home),
      // Without a read cursor, anything finished counts as news, as on a new device.
      baseline: 0,
      settled: false,
      now: input.now,
      projectName: input.projectName(entry.workspaceId),
      readState: entry.readState
        ? { type: "thread.readState", requestId: "cli", threadId: entry.id, ...entry.readState }
        : undefined,
      unconfirmed: input.unconfirmed,
    });
    const look = rowStatusLook(card.attention, card);
    const state = rowStatusState(card.attention, look);
    const glyph =
      look.icon === "agents" && look.count ? `${glyphs.agents}${look.count}` : glyphs[look.icon];
    const time =
      look.mode === "elapsed"
        ? formatElapsed(input.now - (card.status.since ?? activityOf(entry)))
        : look.mode === "age"
          ? formatAge(activityOf(entry), input.now)
          : look.mode === "word"
            ? (look.word ?? "")
            : "";
    return [
      {
        id,
        glyph,
        tone: look.tone,
        state,
        time,
        meaning: look.meaning,
        project: card.project,
        projectId: entry.workspaceId,
        title: card.title,
        branch: card.branch?.name ?? "",
        provider: card.provider,
        needsYou: state === "needs-you",
        running: state === "working" || state === "waiting" || state === "background",
      },
    ];
  });
}

/** How many open requests the list shows: rows that need the person. */
export function requestCount(rows: readonly HomeRow[]): number {
  return rows.filter((row) => row.needsYou).length;
}
