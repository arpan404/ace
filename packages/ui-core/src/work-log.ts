import type { FileChange, Item, ToolCall } from "@ace/protocol";
import { quickStat } from "./file-changes.ts";
import { formatElapsed } from "./time.ts";

export type StepIcon = "read" | "search" | "shell" | "edit" | "web" | "tool" | "think" | "note";

/** How one work-log row reads: "Ran `bun run test`  exit 0". Pure. */
export interface StepText {
  icon: StepIcon;
  verb: string;
  target?: string | undefined;
  /** Trailing note: matches, exit code, diff stat, status. */
  note?: string | undefined;
  added?: number | undefined;
  removed?: number | undefined;
  /**
   * An edit whose stat needs a text diff (full before and after text): `added` and `removed`
   * stay unset and these changes are what to diff, off the main thread.
   */
  diffFor?: readonly FileChange[] | undefined;
  /** False while the step is still in flight. */
  settled: boolean;
  failed: boolean;
}

const unsettled = new Set<ToolCall["status"]>(["pending", "running", "awaiting_approval"]);

function statusNote(call: ToolCall): string | undefined {
  switch (call.status) {
    case "awaiting_approval":
      return "Awaiting approval";
    case "declined":
      return "Declined";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return undefined;
  }
}

/**
 * A step's verb follows its status: "Running `git push`" while in flight, "Run `git push`" while
 * it waits for approval or was declined (it hasn't happened), "Ran" once done.
 */
const inFlight: Record<string, { running: string; awaiting: string }> = {
  Read: { running: "Reading", awaiting: "Read" },
  Searched: { running: "Searching", awaiting: "Search" },
  "Searched the web": { running: "Searching the web", awaiting: "Search the web" },
  Fetched: { running: "Fetching", awaiting: "Fetch" },
  Ran: { running: "Running", awaiting: "Run" },
  Edited: { running: "Editing", awaiting: "Edit" },
  Wrote: { running: "Writing", awaiting: "Write" },
  Deleted: { running: "Deleting", awaiting: "Delete" },
  Moved: { running: "Moving", awaiting: "Move" },
  Called: { running: "Calling", awaiting: "Call" },
  "Updated the plan": { running: "Updating the plan", awaiting: "Update the plan" },
  "Asked a question": { running: "Asking a question", awaiting: "Ask a question" },
  "Messaged a subagent": { running: "Messaging a subagent", awaiting: "Message a subagent" },
};

function verbFor(verb: string, status: ToolCall["status"]): string {
  const forms = inFlight[verb];
  if (!forms) return verb;
  // Waiting for approval, or refused one: it never happened.
  if (status === "awaiting_approval" || status === "declined") return forms.awaiting;
  if (status === "pending" || status === "running") return forms.running;
  return verb;
}

function callText(call: ToolCall): Omit<StepText, "settled" | "failed"> {
  const detail = call.detail;
  switch (detail.kind) {
    case "file.read":
      return { icon: "read", verb: "Read", target: detail.path };
    case "search":
      return {
        icon: "search",
        verb: "Searched",
        target: detail.query,
        note:
          detail.matches === undefined
            ? undefined
            : `${detail.matches} ${detail.matches === 1 ? "match" : "matches"}`,
      };
    case "web.search":
      return { icon: "web", verb: "Searched the web", target: detail.query };
    case "web.fetch":
      return { icon: "web", verb: "Fetched", target: detail.url };
    case "shell": {
      const exit =
        detail.exitCode === undefined || detail.exitCode === null
          ? undefined
          : `exit ${detail.exitCode}`;
      return { icon: "shell", verb: "Ran", target: detail.command, note: exit };
    }
    case "file.edit":
    case "file.write":
    case "file.delete":
    case "file.move": {
      const verb = {
        "file.edit": "Edited",
        "file.write": "Wrote",
        "file.delete": "Deleted",
        "file.move": "Moved",
      }[detail.kind];
      const first = detail.changes[0];
      const target =
        detail.changes.length > 1
          ? `${detail.changes.length} files`
          : first
            ? (first.movePath ?? first.path)
            : undefined;
      let added = 0;
      let removed = 0;
      for (const change of detail.changes) {
        const stat = quickStat(change);
        if (!stat) return { icon: "edit", verb, target, diffFor: detail.changes };
        added += stat.added;
        removed += stat.removed;
      }
      return { icon: "edit", verb, target, added, removed };
    }
    case "mcp":
      return { icon: "tool", verb: "Called", target: `${detail.server}.${detail.tool}` };
    case "todo":
    case "plan":
      return { icon: "note", verb: "Updated the plan" };
    case "ask_user":
      return { icon: "note", verb: "Asked a question" };
    case "agent.message":
      return { icon: "tool", verb: "Messaged a subagent", target: detail.message };
    default:
      return { icon: "tool", verb: call.title };
  }
}

export function describeStep(item: Item): StepText {
  if (item.type === "reasoning")
    return {
      icon: "think",
      verb: item.complete ? "Thought" : "Thinking",
      settled: item.complete,
      failed: false,
    };
  if (item.type === "notice")
    return {
      icon: "note",
      verb: item.text.split("\n")[0] ?? "",
      settled: true,
      failed: item.level === "error",
    };
  if (item.type !== "tool_call")
    return { icon: "tool", verb: item.type, settled: true, failed: false };
  const call = item.call;
  const text = callText(call);
  return {
    ...text,
    verb: verbFor(text.verb, call.status),
    note: statusNote(call) ?? text.note,
    settled: !unsettled.has(call.status),
    failed: call.status === "failed",
  };
}

export interface WorkSummary {
  running: boolean;
  awaiting: boolean;
  failed: number;
  startedAt: number;
  endedAt: number;
  read: number;
  searched: number;
  ran: number;
  edited: number;
  other: number;
  /** The step in flight, for the live line. */
  current: string | undefined;
}

/** Totals for a "Worked for … · Explored N files · Ran N commands" line. Pure. */
export function summarizeWork(items: readonly (Item | undefined)[]): WorkSummary {
  const reads = new Set<string>();
  const edits = new Set<string>();
  const summary: WorkSummary = {
    running: false,
    awaiting: false,
    failed: 0,
    startedAt: Number.POSITIVE_INFINITY,
    endedAt: 0,
    read: 0,
    searched: 0,
    ran: 0,
    edited: 0,
    other: 0,
    current: undefined,
  };
  for (const item of items) {
    if (!item) continue;
    summary.startedAt = Math.min(summary.startedAt, item.createdAt);
    summary.endedAt = Math.max(summary.endedAt, item.createdAt);
    if (item.type !== "tool_call") {
      if (item.type === "reasoning" && !item.complete) summary.running = true;
      continue;
    }
    const call = item.call;
    summary.startedAt = Math.min(summary.startedAt, call.startedAt);
    summary.endedAt = Math.max(summary.endedAt, call.endedAt ?? call.startedAt);
    if (unsettled.has(call.status)) {
      summary.running = true;
      summary.current = call.title;
    }
    if (call.status === "awaiting_approval") summary.awaiting = true;
    if (call.status === "failed") summary.failed++;
    const detail = call.detail;
    if (detail.kind === "file.read") reads.add(detail.path);
    else if (detail.kind === "search" || detail.kind === "web.search") summary.searched++;
    else if (detail.kind === "shell") summary.ran++;
    else if ("changes" in detail) for (const change of detail.changes) edits.add(change.path);
    else summary.other++;
  }
  summary.read = reads.size;
  summary.edited = edits.size;
  if (summary.startedAt === Number.POSITIVE_INFINITY) summary.startedAt = summary.endedAt;
  return summary;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Explored 6 files · 1 search · Ran 3 commands · Edited 2 files". */
export function workCounts(summary: WorkSummary): string {
  const parts: string[] = [];
  if (summary.read) parts.push(`Explored ${plural(summary.read, "file", "files")}`);
  if (summary.searched) parts.push(plural(summary.searched, "search", "searches"));
  if (summary.ran) parts.push(`Ran ${plural(summary.ran, "command", "commands")}`);
  if (summary.edited) parts.push(`Edited ${plural(summary.edited, "file", "files")}`);
  if (summary.other) parts.push(`Used ${plural(summary.other, "tool", "tools")}`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  return parts.join(" · ");
}

/** The work log's one line at rest: "Worked for 4m 12s", the counts, and the step in flight. */
export interface WorkLogHeadline {
  label: string;
  /** "Explored 6 files · Ran 3 commands"; empty when nothing countable ran. */
  counts: string;
  running: boolean;
  /** The step in flight, while running. */
  current: string | undefined;
  /** A step waits for approval, so the log should open by itself. */
  awaiting: boolean;
}

/** Headline for a work log. `now` only matters while it runs; a short burst reads as 1s. */
export function workLogHeadline(summary: WorkSummary, now: number): WorkLogHeadline {
  const end = summary.running ? now : summary.endedAt;
  const elapsed = formatElapsed(Math.max(1000, end - summary.startedAt));
  return {
    label: summary.running ? `Working for ${elapsed}` : `Worked for ${elapsed}`,
    counts: workCounts(summary),
    running: summary.running,
    current: summary.running ? summary.current : undefined,
    awaiting: summary.awaiting,
  };
}
