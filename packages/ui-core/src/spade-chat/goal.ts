import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";

/*
 * A bot's goal, plan and the separate check of done (ADR 0159), as `GET /v1/agents/{id}/task`
 * answers it, and the words every client shows for it. Progress is derived by Spade from the
 * plan's verified items, never the bot's own word, so "done" shows only from it. Parsed
 * leniently: a field this client can't read reads as absent, an item it can't read is left out.
 */

export type SpadeGoalState = "none" | "working" | "checking" | "not_yet" | "unchecked" | "done";

/** Where the goal stands, from the roster's `task_progress` or the task's `progress`. */
export interface SpadeGoalProgress {
  state: SpadeGoalState;
  total: number;
  /** Closed by the bot, verified or not. */
  closed: number;
  verified: number;
}

export interface SpadeCriterion {
  id: string;
  text: string;
}

export interface SpadeGoal {
  id: string;
  title: string;
  /** The person's own words the goal came from. */
  text: string;
  criteria: readonly SpadeCriterion[];
  by: "bot" | "person";
  /** How it ended; undefined while it is open. */
  closed: "done" | "cleared" | undefined;
}

export type SpadeEvidence =
  | { kind: "output"; call: string }
  | { kind: "file"; path: string }
  | { kind: "url"; url: string };

export interface SpadePlanItem {
  id: string;
  text: string;
  parent: string | undefined;
  status: "open" | "working" | "done" | "blocked";
  evidence: readonly SpadeEvidence[];
  /** Why it is blocked, or why the check reopened it. */
  reason: string | undefined;
  verified: boolean;
}

export interface SpadeVerdict {
  finding: "done" | "not_yet" | "unchecked";
  criteria: readonly { id: string; met: boolean; why: string }[];
  rejected: readonly { item: string; why: string }[];
  missing: readonly string[];
}

export interface SpadeTask {
  goal: SpadeGoal;
  items: readonly SpadePlanItem[];
  verdict: SpadeVerdict | undefined;
  progress: SpadeGoalProgress;
}

const count = z.number().int().nonnegative().catch(0).default(0);

const progressShape = z.object({
  state: z.enum(["none", "working", "checking", "not_yet", "unchecked", "done"]).catch("working"),
  items_total: count,
  items_closed: count,
  items_verified: count,
});

const evidenceShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("output"), call: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
  z.object({ kind: z.literal("url"), url: z.string() }),
]);

const itemShape = z.object({
  id: z.string().min(1),
  text: z.string(),
  parent: z.string().nullish().catch(undefined),
  status: z.enum(["open", "working", "done", "blocked"]).catch("open"),
  evidence: z.array(z.unknown()).catch([]).default([]),
  reason: z.string().nullish().catch(undefined),
  verified: z.boolean().catch(false).default(false),
});

const taskShape = z.object({
  goal: z.object({
    id: z.string(),
    title: z.string(),
    text: z.string().catch("").default(""),
    criteria: z
      .array(z.object({ id: z.string(), text: z.string() }))
      .catch([])
      .default([]),
    by: z.enum(["bot", "person"]).catch("bot").default("bot"),
    closed: z.enum(["done", "cleared"]).nullish().catch(undefined),
  }),
  items: z.array(z.unknown()).catch([]).default([]),
  verdict: z
    .object({
      finding: z.enum(["done", "not_yet", "unchecked"]),
      criteria: z
        .array(
          z.object({ id: z.string(), met: z.boolean(), why: z.string().catch("").default("") }),
        )
        .catch([])
        .default([]),
      rejected: z
        .array(z.object({ item: z.string(), why: z.string().catch("").default("") }))
        .catch([])
        .default([]),
      missing: z.array(z.string()).catch([]).default([]),
    })
    .nullish()
    .catch(undefined),
  progress: z.unknown(),
});

function readProgress(value: unknown): SpadeGoalProgress | undefined {
  const parsed = progressShape.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    state: parsed.data.state,
    total: parsed.data.items_total,
    closed: parsed.data.items_closed,
    verified: parsed.data.items_verified,
  };
}

/** The roster's `task_progress` of an agent; undefined from a Spade before goals. */
export function parseSpadeGoalProgress(
  record: Record<string, unknown>,
): SpadeGoalProgress | undefined {
  return readProgress(record.task_progress);
}

function readItem(value: unknown): SpadePlanItem | undefined {
  const parsed = itemShape.safeParse(value);
  if (!parsed.success) return undefined;
  const item = parsed.data;
  return {
    id: item.id,
    text: item.text,
    parent: item.parent ?? undefined,
    status: item.status,
    evidence: item.evidence.flatMap((each) => {
      const evidence = evidenceShape.safeParse(each);
      return evidence.success ? [evidence.data] : [];
    }),
    reason: item.reason ?? undefined,
    verified: item.verified,
  };
}

/**
 * `{"task": {…}}`: the task, `null` when the bot never had a goal, undefined when the body
 * makes no sense.
 */
export function parseSpadeTask(body: string): SpadeTask | null | undefined {
  const record = spadeRecord(spadeJson(body));
  if (!record || !("task" in record)) return undefined;
  if (record.task === null) return null;
  const parsed = taskShape.safeParse(record.task);
  if (!parsed.success) return undefined;
  const { goal, verdict } = parsed.data;
  const items = parsed.data.items.flatMap((each) => {
    const item = readItem(each);
    return item ? [item] : [];
  });
  return {
    goal: { ...goal, closed: goal.closed ?? undefined },
    items,
    verdict: verdict ?? undefined,
    progress: readProgress(parsed.data.progress) ?? {
      state: goal.closed === "cleared" ? "none" : "working",
      total: items.length,
      closed: items.filter((item) => item.status === "done").length,
      verified: items.filter((item) => item.verified).length,
    },
  };
}

/** Whether the bot has a goal to show: open, or done; one the person ended is gone. */
export function spadeGoalShown(task: SpadeTask | null | undefined): task is SpadeTask {
  return task !== null && task !== undefined && task.goal.closed !== "cleared";
}

const counted = (progress: SpadeGoalProgress) =>
  `${progress.verified} of ${progress.total} verified`;

/**
 * The list row's words for a bot's goal, from the derived progress only: "4 of 6 verified",
 * "Checking", "Not yet: Linux CI still fails", "Says done, not checked", "Done · 6 of 6
 * verified". Never the bot's own "done". Undefined with no goal.
 */
export function spadeGoalLine(
  progress: SpadeGoalProgress | undefined,
  /** What the check found missing, when it is known. */
  missing?: string,
): string | undefined {
  if (!progress) return undefined;
  switch (progress.state) {
    case "none":
      return undefined;
    case "working":
      return progress.total > 0 ? counted(progress) : "Working on its goal";
    case "checking":
      return "Checking";
    case "not_yet":
      return missing ? `Not yet: ${missing}` : "Not yet";
    case "unchecked":
      return "Says done, not checked";
    case "done":
      return progress.total > 0 ? `Done · ${counted(progress)}` : "Done";
  }
}

/** The Goal heading's state, once: "Not yet", "Checking", "Done", or the verified count. */
export function spadeGoalHeading(progress: SpadeGoalProgress): string {
  switch (progress.state) {
    case "checking":
      return "Checking";
    case "not_yet":
      return "Not yet";
    case "unchecked":
      return "Says done, not checked";
    case "done":
      return "Done";
    default:
      return progress.total > 0 ? counted(progress) : "";
  }
}

/** The first thing the latest check found missing, for "Not yet: …". */
export function spadeGoalMissing(task: SpadeTask): string | undefined {
  if (task.verdict?.finding !== "not_yet") return undefined;
  return task.verdict.missing[0];
}

export interface SpadeCriterionMark extends SpadeCriterion {
  met: boolean;
  /** Why it isn't met, from the check that just answered; undefined otherwise. */
  why: string | undefined;
}

/**
 * Each criterion with the check's verdict: a mark for each one met, and under each one not met,
 * why. While a new claim is being checked the earlier marks stay and no reasons show; a check
 * that couldn't run says so once (`note`).
 */
export function spadeCriteriaMarks(task: SpadeTask): {
  criteria: SpadeCriterionMark[];
  note: string | undefined;
} {
  const verdict = task.verdict;
  const judged = task.progress.state === "not_yet" || task.progress.state === "done";
  const checks = new Map(verdict?.criteria.map((check) => [check.id, check]));
  const criteria = task.goal.criteria.map((criterion) => {
    const check = checks.get(criterion.id);
    const met = task.progress.state === "done" || check?.met === true;
    return {
      ...criterion,
      met,
      why: judged && check && !check.met && check.why ? check.why : undefined,
    };
  });
  const reason = task.progress.state === "unchecked" ? verdict?.missing[0] : undefined;
  return {
    criteria,
    note: reason
      ? `The check couldn't run: ${lowerFirst(reason)}. It runs again on the next claim.`
      : undefined,
  };
}

const lowerFirst = (text: string) => {
  const trimmed = text.trim().replace(/\.$/, "");
  return trimmed.charAt(0).toLocaleLowerCase() + trimmed.slice(1);
};

/** An item's mark: verified, done but not checked, in progress, waiting, or not started. */
export type SpadePlanMark = "verified" | "claimed" | "working" | "waiting" | "open";

export interface SpadePlanRow {
  item: SpadePlanItem;
  depth: number;
  mark: SpadePlanMark;
  /** "Not yet: …" from the check that reopened it, or what it waits on. */
  note: { tone: "not-yet" | "waiting"; text: string } | undefined;
}

/** The plan in order, each item under its parent, with its mark and its one note. */
export function spadePlanRows(items: readonly SpadePlanItem[]): SpadePlanRow[] {
  const known = new Set(items.map((item) => item.id));
  const children = new Map<string | undefined, SpadePlanItem[]>();
  for (const item of items) {
    // An item whose parent this client didn't get stays at the top, never lost.
    const parent = item.parent && known.has(item.parent) ? item.parent : undefined;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const rows: SpadePlanRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | undefined, depth: number) => {
    for (const item of children.get(parent) ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rows.push({ item, depth, mark: markOf(item), note: noteOf(item) });
      walk(item.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}

function markOf(item: SpadePlanItem): SpadePlanMark {
  if (item.status === "done") return item.verified ? "verified" : "claimed";
  if (item.status === "blocked") return "waiting";
  return item.status === "working" ? "working" : "open";
}

function noteOf(item: SpadePlanItem): SpadePlanRow["note"] {
  if (!item.reason) return undefined;
  if (item.status === "blocked") return { tone: "waiting", text: item.reason };
  if (item.status === "done") return undefined;
  return { tone: "not-yet", text: item.reason };
}
