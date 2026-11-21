import type { CliTree, Interaction, Item, ThreadStatus } from "@ace/protocol";
import type { RowStatusIconKind, RowStatusTone } from "@ace/ui-core";
import { treeOutcome } from "../../work-outcome.ts";
import { paint } from "./thread-glyph.ts";
import { requestLine } from "./request.ts";

/** What `ace thread show` prints from: the thread, a bounded window of items, its requests. */
export interface ThreadShowView {
  readonly thread: {
    readonly id: string;
    readonly title: string;
    readonly provider: string;
    readonly model?: string | undefined;
    readonly workspaceId: string;
    readonly status: ThreadStatus;
  };
  readonly project?: string | undefined;
  /** The row's own status words when the list has it ("Waiting on 2 agents"). */
  readonly meaning?: string | undefined;
  readonly items: readonly (Item | undefined)[];
  /** The cursor for older items, or null at the start of the thread. */
  readonly itemsBefore: number | null;
  readonly interactions: readonly (Interaction | undefined)[];
}

/** Lines one message may take before the rest is cut; a thread show stays bounded. */
const messageLines = 12;

function cutLines(text: string, max: number): string[] {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… ${lines.length - max} more lines`];
}

function messageText(item: Extract<Item, { type: "message" }>): string {
  return item.parts
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n")
    .trim();
}

/** One transcript item as the lines a person reads; reasoning and raw frames stay out. */
export function itemLines(item: Item): string[] {
  switch (item.type) {
    case "message": {
      if (item.synthetic) return [];
      const text = messageText(item);
      if (!text) return [];
      const [first = "", ...rest] = cutLines(text, messageLines);
      const lead = item.role === "user" ? "› " : "  ";
      return [`${lead}${first}`, ...rest.map((line) => `  ${line}`)];
    }
    case "tool_call":
      return [`  · ${item.call.title}`];
    case "notice":
      return [`  ${item.level === "error" ? "✕ " : ""}${item.title ?? item.text}`];
    case "delegation.started":
      return [`  ↳ ${item.title} (${item.provider})`];
    case "compaction":
      return ["  Context compacted."];
    default:
      return [];
  }
}

export function threadShowLines(view: ThreadShowView, colour: boolean): string[] {
  const { thread } = view;
  const status = view.meaning ?? statusWords(thread.status);
  const model = thread.model ? ` · ${thread.model}` : "";
  const lines = [
    thread.title,
    `${thread.id}  ${view.project ?? thread.workspaceId}  ${thread.provider}${model}  ${status}`,
  ];
  if (view.itemsBefore !== null)
    lines.push(`Earlier: ace thread show ${thread.id} --before ${view.itemsBefore}`);
  const body = view.items.flatMap((item) => (item ? itemLines(item) : []));
  if (body.length) lines.push("", ...body);
  const open = view.interactions.filter(
    (interaction): interaction is Interaction => interaction?.state === "pending",
  );
  if (open.length) lines.push("", ...open.map((interaction) => requestLine(interaction, colour)));
  return lines;
}

/** A thread status in a few words: "Working", "Needs you", "Done". */
export function statusWords(status: ThreadStatus): string {
  switch (status.state) {
    case "needs_you":
      return "Needs you";
    case "working":
      return "Working";
    case "waiting":
      return `Waiting on ${status.on.replace("_", " ")}`;
    case "limited":
      return "Limited";
    case "failed":
      return "Failed";
    case "unresponsive":
      return "Not responding";
    case "done":
      return "Done";
    case "new":
      return "New";
    case "moved":
      return `Moved to ${status.to.name}`;
    case "unknown":
      return "Status unknown";
  }
}

function memberMark(status: ThreadStatus): {
  icon: RowStatusIconKind | "none";
  tone: RowStatusTone;
} {
  switch (status.state) {
    case "needs_you":
      return { icon: "approve", tone: "needs-you" };
    case "failed":
    case "unresponsive":
      return { icon: "failed", tone: "failed" };
    case "working":
      return { icon: "working", tone: "working" };
    case "waiting":
      return { icon: "waiting", tone: "waiting" };
    case "limited":
      return { icon: "limited", tone: "limited" };
    case "done":
      return { icon: "done", tone: "finished" };
    case "new":
    case "moved":
    case "unknown":
      return { icon: "none", tone: "idle" };
  }
}

const memberGlyph: Record<RowStatusIconKind | "none", string> = {
  approve: "◆",
  question: "?",
  model: "✦",
  failed: "✕",
  working: "◌",
  agents: "◌",
  waiting: "◌",
  background: "▣",
  limited: "◷",
  done: "✓",
  none: " ",
};

type Member = CliTree[number];

export interface MemberState {
  readonly symbol: string;
  readonly tone: RowStatusTone;
  readonly words: string;
}

/**
 * One member's state counting the agents under it: a member whose own turn ended while agents
 * under it still work reads as waiting on them, and one with an agent under it waiting on the
 * person reads as needing you. Never done while any part of its tree works or waits
 * (AGENTS.md priority 1). Pure.
 */
export function memberState(member: Member, below: readonly Member[]): MemberState {
  const ended = member.status.state === "done" && below.length > 0;
  const outcome = ended ? treeOutcome([{ ...member, pending: false }, ...below]) : "ok";
  if (outcome === "needs-human")
    return { symbol: "◆", tone: "needs-you", words: "An agent under it needs you" };
  if (outcome === undefined) {
    const open = below.filter((each) => each.pending || treeOutcome([each]) === undefined).length;
    return {
      symbol: `◌${open || ""}`,
      tone: "waiting",
      words: open
        ? `Waiting on ${open} ${open === 1 ? "agent" : "agents"}`
        : "Waiting on its agents",
    };
  }
  const mark = memberMark(member.status);
  return { symbol: memberGlyph[mark.icon], tone: mark.tone, words: statusWords(member.status) };
}

/** The root's state over its whole tree: what `thread show` and `thread status` say. */
export function rootState(tree: CliTree): MemberState | undefined {
  const [root, ...rest] = tree;
  return root ? memberState(root, rest) : undefined;
}

/**
 * The agent tree (ADR 0108): each thread under the one that delegated it, with its own state
 * counting the agents under it (`memberState`). Pure.
 */
export function treeLines(tree: CliTree, colour: boolean): string[] {
  const children = new Map<string, Member[]>();
  const ids = new Set(tree.map((member) => member.threadId));
  const rootId = tree[0]?.threadId;
  for (const member of tree.slice(1)) {
    const parent = member.parentId && ids.has(member.parentId) ? member.parentId : rootId;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), member]);
  }
  const below = (id: string, depth = 0): Member[] => {
    const found: Member[] = [];
    if (depth > 8) return found;
    for (const child of children.get(id) ?? [])
      found.push(child, ...below(child.threadId, depth + 1));
    return found;
  };
  const lines: string[] = [];
  const walk = (member: Member, depth: number) => {
    if (depth > 8) return;
    const state = memberState(member, below(member.threadId));
    const name = member.title ?? member.threadId;
    lines.push(
      `${"  ".repeat(depth)}${paint(state.symbol, state.tone, colour)} ${name}  ${member.threadId}  ${state.words}`,
    );
    for (const child of children.get(member.threadId) ?? []) walk(child, depth + 1);
  };
  if (tree[0]) walk(tree[0], 0);
  return lines;
}

/** How `thread wait` ends, one line per thread, in words. Pure. */
export function outcomeLines(
  outcomes: readonly {
    readonly threadId: string;
    readonly status: "ok" | "failed" | "needs-human" | "uncertain";
    readonly thread: { readonly title: string };
    readonly cancelled: readonly string[];
  }[],
): string[] {
  return outcomes.map((each) => {
    const name = `${each.thread.title}  ${each.threadId}`;
    switch (each.status) {
      case "ok":
        return `✓ Done  ${name}`;
      case "failed":
        return each.cancelled.length ? `✕ Stopped  ${name}` : `✕ Failed  ${name}`;
      case "needs-human":
        return `◆ Needs you  ${name}  See it with ace request list --thread ${each.threadId}`;
      case "uncertain":
        return `? ace can't tell how it ended  ${name}`;
    }
  });
}
