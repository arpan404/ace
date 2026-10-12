import { toolSurface } from "@ace/projection";
import type { Item } from "@ace/protocol";
import { displayCommand } from "./step-display.ts";
import { exploreAction } from "./explore-command.ts";

/*
 * A work log's steps as rows: consecutive tool calls by one agent group into one summary row
 * ("Edited 2 files · ran 1 command"), exploration alone into "Explored 3 files · 2 searches".
 * What the agent says between steps, an image it showed and ace's review of a step stand alone
 * and end the group before them. Appending a step regroups only the last group, so a live log
 * costs what changed, not its history. Pure.
 */

export type StepKind =
  | "edit"
  | "command"
  | "computer"
  | "browser"
  | "fetch"
  | "websearch"
  | "read"
  | "list"
  | "search"
  | "plan"
  | "agent"
  | "spawn"
  | "tool"
  | "think";

/** What grouping needs to know of one work-log entry. */
export interface StepFact {
  id: string;
  agentId: string;
  kind: StepKind;
  /** Prose, an image, a review: shown as its own row, never folded into a group. */
  alone: boolean;
  running: boolean;
  /** Failed, and not run again with success later. */
  failed: boolean;
  /** What it acted on, for distinct counts: a file, a site's origin, an app. */
  target?: string | undefined;
}

export interface StepGroup {
  key: string;
  agentId: string;
  ids: readonly string[];
  /** One step, or one that stands alone: its own row, no summary. */
  single: boolean;
  /** "Edited 2 files · ran 1 command · 1 failed"; empty for a single step. */
  summary: string;
  /** The summary without its failures, for a row that shows them apart. */
  sentence: string;
  running: boolean;
  failed: number;
  /** Only reads, listings and searches. */
  explore: boolean;
  icon: GroupIcon;
  /** The newest step, which stays in view while the group is folded. */
  newest: string;
}

const exploring = new Set<StepKind>(["read", "list", "search"]);

/**
 * How one item counts for grouping; `retried` holds failed steps a later step re-ran. Undefined
 * for what is no step at all: a finished thought with no words, a person's or synthetic message,
 * a launch or bookkeeping record.
 */
export function stepFact(item: Item, retried?: ReadonlySet<string>): StepFact | undefined {
  const base = {
    id: item.id,
    agentId: item.agentId ?? "",
    alone: false,
    running: false,
    failed: false,
  };
  switch (item.type) {
    case "reasoning":
      // What the agent thought reads on its own row, between the steps.
      if (item.complete && !item.text.trim()) return undefined;
      return { ...base, kind: "think", alone: true, running: !item.complete };
    case "message":
      if (item.role !== "assistant" || item.synthetic) return undefined;
      return { ...base, kind: "tool", alone: true, running: !item.complete };
    case "notice":
      return { ...base, kind: "tool", alone: true };
    case "tool_call":
      break;
    default:
      return undefined;
  }
  const call = item.call;
  const running =
    call.status === "pending" || call.status === "running" || call.status === "awaiting_approval";
  const failed = call.status === "failed" && !retried?.has(item.id);
  const fact = { ...base, running, failed };
  const detail = call.detail;
  switch (detail.kind) {
    case "file.read":
      return { ...fact, kind: "read", target: detail.path };
    case "search":
      return { ...fact, kind: "search" };
    case "file.edit":
    case "file.write":
    case "file.delete":
    case "file.move":
      return {
        ...fact,
        kind: "edit",
        target: detail.changes.map((change) => change.path).join("\u0000"),
      };
    case "shell": {
      const explored = exploreAction(displayCommand(detail).command);
      return { ...fact, kind: explored ?? "command", target: undefined };
    }
    case "web.search":
      return { ...fact, kind: "websearch" };
    case "todo":
    case "plan":
      return { ...fact, kind: "plan" };
    case "agent.message":
      return { ...fact, kind: "agent" };
    case "agent.spawn":
      return { ...fact, kind: "spawn" };
    case "image":
      return { ...fact, kind: "tool", alone: !!detail.attachment };
    default:
      break;
  }
  const surface = toolSurface(call);
  if (surface?.kind === "computer")
    return {
      ...fact,
      kind: "computer",
      target: surface.icon?.kind === "app" ? surface.icon.identity : undefined,
    };
  if (surface)
    return {
      ...fact,
      kind: detail.kind === "web.fetch" ? "fetch" : "browser",
      target: surface.icon?.kind === "site" ? surface.icon.origin : undefined,
    };
  return { ...fact, kind: "tool" };
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function distinct(facts: readonly StepFact[], kind: StepKind): number {
  const targets = new Set<string>();
  for (const fact of facts)
    if (fact.kind === kind)
      for (const target of fact.target?.split("\u0000") ?? [`#${fact.id}`]) targets.add(target);
  return targets.size;
}

/** Each kind's phrase, mutating kinds first. */
function phrases(facts: readonly StepFact[]): { kind: StepKind; text: string; steps: number }[] {
  const count = (kind: StepKind) => facts.filter((fact) => fact.kind === kind).length;
  const out: { kind: StepKind; text: string; steps: number }[] = [];
  const add = (kind: StepKind, text: (steps: number) => string) => {
    const steps = count(kind);
    if (steps) out.push({ kind, text: text(steps), steps });
  };
  const known = (kind: StepKind) =>
    facts.some((fact) => fact.kind === kind && fact.target)
      ? distinct(
          facts.filter((fact) => fact.target),
          kind,
        )
      : 0;
  add("edit", () => `edited ${plural(distinct(facts, "edit"), "file")}`);
  add("command", (steps) => `ran ${plural(steps, "command")}`);
  add("computer", (steps) => `used ${plural(known("computer") || steps, "app")}`);
  add("browser", (steps) =>
    known("browser")
      ? `visited ${plural(known("browser"), "site")}`
      : `browsed ${plural(steps, "page")}`,
  );
  add("fetch", (steps) => `fetched ${plural(steps, "page")}`);
  add("websearch", (steps) => `searched the web ${steps === 1 ? "once" : `${steps} times`}`);
  add("read", () => `read ${plural(distinct(facts, "read"), "file")}`);
  add("search", (steps) => `searched ${steps === 1 ? "once" : `${steps} times`}`);
  add("list", (steps) => `listed ${plural(steps, "folder")}`);
  add("plan", () => "updated the plan");
  add("spawn", (steps) => `started ${plural(steps, "subagent")}`);
  add("agent", (steps) => `messaged ${plural(steps, "subagent")}`);
  add("tool", (steps) => `used ${plural(steps, "tool")}`);
  return out;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "a", "a and b", "a, b and c". */
function sentence(parts: readonly string[]): string {
  if (parts.length < 3) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** What a group's icon shows: its one kind of step, exploration, or a mix. */
export type GroupIcon = StepKind | "explore" | "mixed";

function exploreOnly(facts: readonly StepFact[]): boolean {
  return facts.every((fact) => exploring.has(fact.kind));
}

/**
 * "Ran 5 commands and read 1 file", "Explored 3 files and 2 searches", "Edited 2 files, ran 1
 * command and 3 other steps". At most two kinds are named, changes first. A failure not run
 * again with success adds " · 1 failed".
 */
export function groupSummary(facts: readonly StepFact[]): string {
  const failed = facts.filter((fact) => fact.failed).length;
  const text = groupSentence(facts);
  return failed ? `${text} · ${failed} failed` : text;
}

/** The group's sentence alone, without its failures: "Ran 5 commands and read 1 file". */
export function groupSentence(facts: readonly StepFact[]): string {
  let text: string;
  if (exploreOnly(facts)) {
    const reads = distinct(facts, "read");
    const searches = facts.filter((fact) => fact.kind === "search").length;
    const lists = facts.filter((fact) => fact.kind === "list").length;
    text = `Explored ${sentence(
      [
        reads ? plural(reads, "file") : "",
        searches ? plural(searches, "search", "searches") : "",
        lists ? plural(lists, "folder") : "",
      ].filter(Boolean),
    )}`;
  } else {
    const named = phrases(facts);
    const parts = named.slice(0, 2).map((phrase) => phrase.text);
    const others = named.slice(2).reduce((total, phrase) => total + phrase.steps, 0);
    if (others) parts.push(plural(others, "other step"));
    text = capital(sentence(parts));
  }
  return text;
}

/** The group's icon kind. */
export function groupIcon(facts: readonly StepFact[]): GroupIcon {
  const kinds = new Set(facts.map((fact) => fact.kind));
  const [only] = kinds;
  // One kind of step (only listings, say) shows that kind's icon, as each of its rows does.
  if (kinds.size === 1 && only) return only;
  return exploreOnly(facts) ? "explore" : "mixed";
}

function makeGroup(facts: readonly StepFact[]): StepGroup {
  const first = facts[0];
  const last = facts.at(-1);
  if (!first || !last) throw new Error("A group holds at least one step");
  const single = facts.length === 1;
  return {
    key: first.id,
    agentId: first.agentId,
    ids: facts.map((fact) => fact.id),
    single,
    summary: single ? "" : groupSummary(facts),
    sentence: single ? "" : groupSentence(facts),
    running: facts.some((fact) => fact.running),
    failed: facts.filter((fact) => fact.failed).length,
    explore: exploreOnly(facts),
    icon: groupIcon(facts),
    newest: last.id,
  };
}

/** Whether `fact` joins the group holding `facts`. */
function joins(facts: readonly StepFact[], fact: StepFact): boolean {
  const last = facts.at(-1);
  return !!last && !last.alone && !fact.alone && last.agentId === fact.agentId;
}

export interface GroupedSteps {
  facts: readonly StepFact[];
  groups: readonly StepGroup[];
}

export const sameFact = (a: StepFact, b: StepFact) =>
  a.id === b.id &&
  a.agentId === b.agentId &&
  a.kind === b.kind &&
  a.alone === b.alone &&
  a.running === b.running &&
  a.failed === b.failed &&
  a.target === b.target;

/**
 * The steps' groups. With the previous grouping of the same log, only the groups from the first
 * changed step on are built again; earlier groups are the same objects, so their rows skip
 * rendering.
 */
export function groupSteps(facts: readonly StepFact[], previous?: GroupedSteps): GroupedSteps {
  let groups: StepGroup[] = [];
  let from = 0;
  if (previous) {
    // The first changed step; everything before its group stands.
    let changed = 0;
    const limit = Math.min(previous.facts.length, facts.length);
    while (changed < limit) {
      const before = previous.facts[changed];
      const now = facts[changed];
      if (!before || !now || !sameFact(before, now)) break;
      changed++;
    }
    if (changed === facts.length && changed === previous.facts.length) return previous;
    let start = 0;
    for (const group of previous.groups) {
      if (start + group.ids.length > changed) break;
      // The last kept group may grow, so it is built again too.
      if (start + group.ids.length === changed && changed < facts.length) break;
      groups.push(group);
      start += group.ids.length;
    }
    from = start;
  }
  const kept = groups.length;
  let open: StepFact[] = [];
  for (let index = from; index < facts.length; index++) {
    const fact = facts[index];
    if (!fact) continue;
    if (open.length && !joins(open, fact)) {
      groups.push(makeGroup(open));
      open = [];
    }
    open.push(fact);
  }
  if (open.length) groups.push(makeGroup(open));
  if (previous) {
    // A rebuilt group that reads as before stays the same object.
    const old = new Map(previous.groups.slice(kept).map((group) => [group.key, group]));
    groups = groups.map((group, index) => {
      if (index < kept) return group;
      const before = old.get(group.key);
      return before && sameGroup(before, group) ? before : group;
    });
  }
  return { facts, groups };
}

function sameGroup(a: StepGroup, b: StepGroup): boolean {
  return (
    a.key === b.key &&
    a.summary === b.summary &&
    a.sentence === b.sentence &&
    a.running === b.running &&
    a.failed === b.failed &&
    a.newest === b.newest &&
    a.ids.length === b.ids.length &&
    a.ids.every((id, index) => id === b.ids[index])
  );
}
