import type { FileChange, Interaction, Item, ToolCall } from "@ace/protocol";
import { quickStat } from "./file-changes.ts";
import { displayCommand, stepPath, type PathContext } from "./step-display.ts";
import type { StepLabels } from "./tool-labels.ts";
import type { AceToolContext, AceToolView } from "./ace-tools.ts";
import { formatElapsed } from "./time.ts";
import { planCount, planProgress, planTodos } from "./plan.ts";

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
  /** The full target (absolute path, whole command) for the row's tooltip. */
  title?: string | undefined;
  /** The step waits on the person: an approval nobody has answered yet. */
  needsYou?: boolean | undefined;
  /** One of ace's own tools: what it acted on, the images it returned, a failure in words. */
  ace?: AceToolView | undefined;
}

/** What a step row needs beyond its item: where it ran, and the approval that gated it. */
export interface StepContext extends PathContext {
  /** The approval interaction whose `toolCallId` is this step. */
  interaction?:
    | Pick<Interaction, "state" | "request" | "resolution" | "review" | "autoReviewed">
    | undefined;
  /** The option the person just picked on this device, before the daemon confirms it. */
  answering?: string | undefined;
  labels?: StepLabels | undefined;
  /** What earlier steps of the log say about this one, for ace's own tools. */
  ace?: AceToolContext | undefined;
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
  "Loaded skill": { running: "Loading skill", awaiting: "Load skill" },
};

function verbFor(verb: string, status: ToolCall["status"]): string {
  const forms = inFlight[verb];
  if (!forms) return verb;
  // Waiting for approval, or refused one: it never happened.
  if (status === "awaiting_approval" || status === "declined") return forms.awaiting;
  if (status === "pending" || status === "running") return forms.running;
  return verb;
}

type CallText = Omit<StepText, "settled" | "failed"> & {
  /** Verb forms for steps whose verb is not in the shared table. */
  forms?: { running: string; awaiting: string };
};

function callText(call: ToolCall, context: StepContext): CallText {
  const detail = call.detail;
  switch (detail.kind) {
    case "file.read": {
      const path = stepPath(detail.path, context);
      if (path.skill)
        return { icon: "read", verb: "Loaded skill", target: path.skill, title: path.full };
      const range = detail.range ? `:${detail.range.start}-${detail.range.end}` : "";
      return { icon: "read", verb: "Read", target: path.text + range, title: path.full };
    }
    case "search": {
      const where = detail.path ? stepPath(detail.path, context).text : undefined;
      return {
        icon: "search",
        verb: "Searched",
        target: where && where !== "." ? `${detail.query} in ${where}` : detail.query,
        note:
          detail.matches === undefined
            ? undefined
            : `${detail.matches} ${detail.matches === 1 ? "match" : "matches"}`,
      };
    }
    case "web.search":
      return { icon: "web", verb: "Searched the web", target: detail.query };
    case "web.fetch":
      return { icon: "web", verb: "Fetched", target: detail.url, title: detail.url };
    case "shell": {
      const command = displayCommand(detail);
      const exit =
        detail.exitCode === undefined || detail.exitCode === null
          ? undefined
          : `exit ${detail.exitCode}`;
      return {
        icon: "shell",
        verb: "Ran",
        target: command.command,
        note: exit,
        title: command.raw ?? command.command,
      };
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
      const path = first ? stepPath(first.movePath ?? first.path, context) : undefined;
      const target = detail.changes.length > 1 ? `${detail.changes.length} files` : path?.text;
      const title = detail.changes.length > 1 ? undefined : path?.full;
      let added = 0;
      let removed = 0;
      for (const change of detail.changes) {
        const stat = quickStat(change);
        if (!stat) return { icon: "edit", verb, target, title, diffFor: detail.changes };
        added += stat.added;
        removed += stat.removed;
      }
      return { icon: "edit", verb, target, title, added, removed };
    }
    case "mcp": {
      if (!context.labels)
        return {
          icon: "tool",
          verb: "Used a tool",
          forms: { running: "Using a tool", awaiting: "Use a tool" },
        };
      const label = context.labels.mcp(detail.server, detail.tool, detail.arguments);
      return {
        icon: label.icon === "agent" ? "tool" : label.icon === "shell" ? "shell" : label.icon,
        verb: label.verb,
        target: label.target,
        forms: { running: label.running, awaiting: label.awaiting },
      };
    }
    case "todo":
    case "plan": {
      // One quiet line, "Updated the plan … 3 of 6"; the list itself is the composer's tab.
      const progress = planProgress(planTodos(detail));
      return {
        icon: "note",
        verb: "Updated the plan",
        note: progress.total ? planCount(progress) : undefined,
      };
    }
    case "ask_user":
      return { icon: "note", verb: "Asked a question" };
    case "agent.message":
      return { icon: "tool", verb: "Messaged a subagent", target: detail.message };
    default: {
      if (!context.labels)
        return {
          icon: detail.kind === "browser" ? "web" : "tool",
          verb: "Used a tool",
          forms: { running: "Using a tool", awaiting: "Use a tool" },
        };
      const label = context.labels.named(detail.kind, call.title);
      return {
        icon: label.icon === "web" ? "web" : "tool",
        verb: label.verb,
        target: label.target,
        forms: { running: label.running, awaiting: label.awaiting },
      };
    }
  }
}

/** The trailing note: the approval's outcome, a failure's reason, or the step's own note. */
function noteFor(call: ToolCall, text: CallText, context: StepContext) {
  if (call.status === "failed") {
    const exit = call.detail.kind === "shell" ? text.note : undefined;
    return { note: exit ?? context.labels?.error(call.error) ?? "Failed" };
  }
  // The approval reads on its step, settled or not: "Approved by you", "Denied by ace".
  if (context.labels && context.interaction?.request.kind === "approval") {
    const outcome = context.labels.approval(context.interaction, context.answering);
    return { note: outcome.text, needsYou: outcome.state === "pending", outcome };
  }
  return { note: statusNote(call) ?? text.note };
}

/**
 * How one step reads. `context` shortens its paths (IR-6) and, for a step behind an approval,
 * turns the approval into the row's note ("Approved by you", IR-2).
 */
export function describeStep(item: Item, context: StepContext = {}): StepText {
  if (item.type === "reasoning")
    return {
      icon: "think",
      verb: item.complete ? "Thought" : "Thinking",
      settled: item.complete,
      failed: false,
    };
  const ace = context.labels?.ace(item, context.ace);
  if (item.type === "notice" && ace)
    return {
      icon: ace.family === "browser" ? "web" : "tool",
      verb: ace.problem?.title ?? ace.words.past,
      target: ace.problem ? undefined : ace.words.target,
      note: ace.problem ? "Failed" : undefined,
      settled: true,
      failed: !!ace.problem,
      ace,
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
  const text: CallText = ace
    ? {
        icon: ace.family === "browser" ? "web" : "tool",
        verb: ace.words.past,
        target: ace.words.target,
        forms: { running: ace.words.running, awaiting: ace.words.awaiting },
        ace,
      }
    : callText(call, context);
  const { forms, ...shown } = text;
  const { note, needsYou, outcome } = noteFor(call, text, context);
  // An approval the person just gave runs next; one they refused never ran.
  const status =
    call.status === "awaiting_approval" && outcome && outcome.state !== "pending"
      ? outcome.tone === "approved"
        ? "running"
        : "declined"
      : call.status;
  const verb = forms
    ? status === "awaiting_approval" || status === "declined"
      ? forms.awaiting
      : status === "pending" || status === "running"
        ? forms.running
        : text.verb
    : verbFor(text.verb, status);
  // ace's own failure reads as what went wrong, in words; its code waits in the details.
  const problem = ace?.problem;
  return {
    ...shown,
    verb: problem?.title ?? verb,
    ...(problem ? { target: undefined } : {}),
    note: problem ? "Failed" : note,
    needsYou,
    settled: !unsettled.has(status),
    failed: call.status === "failed" || !!problem || outcome?.tone === "denied",
  };
}

/** "Running bun install" for the live line: the step in flight, never the provider's title. */
export function stepLine(item: Item, context: StepContext = {}): string {
  const step = describeStep(item, context);
  return step.target ? `${step.verb} ${step.target}` : step.verb;
}

export interface WorkSummary {
  running: boolean;
  awaiting: boolean;
  /** Steps that failed and were not re-run successfully later in the group. */
  failed: number;
  /** Failed steps a later step re-ran with success: "· 1 retried". */
  retried: number;
  /** The first step counted in `failed`, to scroll to. */
  firstFailed: string | undefined;
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
    retried: 0,
    firstFailed: undefined,
    startedAt: Number.POSITIVE_INFINITY,
    endedAt: 0,
    read: 0,
    searched: 0,
    ran: 0,
    edited: 0,
    other: 0,
    current: undefined,
  };
  // A failed command run again later with success was retried, not failed (TS-6).
  const failures: { id: string; key: string }[] = [];
  const succeeded = new Map<string, number>();
  items.forEach((item, index) => {
    if (item?.type !== "tool_call") return;
    const key = retryKey(item);
    if (key && item.call.status === "succeeded") succeeded.set(key, index);
  });
  for (const [index, item] of items.entries()) {
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
      summary.current = stepLine(item);
    }
    if (call.status === "awaiting_approval") summary.awaiting = true;
    if (call.status === "failed") {
      const key = retryKey(item);
      if (key && (succeeded.get(key) ?? -1) > index) summary.retried++;
      else failures.push({ id: item.id, key: key ?? item.id });
    }
    const detail = call.detail;
    if (detail.kind === "file.read") reads.add(detail.path);
    else if (detail.kind === "search" || detail.kind === "web.search") summary.searched++;
    else if (detail.kind === "shell") summary.ran++;
    else if ("changes" in detail) for (const change of detail.changes) edits.add(change.path);
    else summary.other++;
  }
  summary.failed = failures.length;
  summary.firstFailed = failures[0]?.id;
  summary.read = reads.size;
  summary.edited = edits.size;
  if (summary.startedAt === Number.POSITIVE_INFINITY) summary.startedAt = summary.endedAt;
  return summary;
}

/**
 * Two steps are the same step tried again only when the same agent, in the same turn, ran the
 * exact same command in the same directory, or read the same lines of the same file (TS-6).
 * A success elsewhere (another directory, another range, another agent) retries nothing.
 */
function retryKey(item: Extract<Item, { type: "tool_call" }>): string | undefined {
  const detail = item.call.detail;
  const where = `${item.agentId}\u0000${item.runId ?? ""}`;
  if (detail.kind === "shell") {
    // The exact string run: the adapter's `rawCommand` when it sends one.
    const exact = detail.rawCommand ?? detail.command;
    return `shell\u0000${where}\u0000${detail.cwd ?? ""}\u0000${exact}`;
  }
  if (detail.kind === "file.read")
    return `read\u0000${where}\u0000${detail.path}\u0000${detail.range ? `${detail.range.start}-${detail.range.end}` : ""}`;
  return undefined;
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
  const failures = failureCounts(summary);
  if (failures) parts.push(failures);
  return parts.join(" · ");
}

/** "2 failed · 1 retried", or "" when nothing failed. Its own part, so it can be a button. */
export function failureCounts(summary: Pick<WorkSummary, "failed" | "retried">): string {
  const parts: string[] = [];
  if (summary.failed) parts.push(`${summary.failed} failed`);
  if (summary.retried) parts.push(`${summary.retried} retried`);
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
  /** "2 failed · 1 retried" (also the end of `counts`), and the first failed step. */
  failures?: string | undefined;
  firstFailed?: string | undefined;
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
    failures: failureCounts(summary),
    firstFailed: summary.firstFailed,
  };
}
