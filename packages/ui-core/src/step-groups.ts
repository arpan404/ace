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
  running: boolean;
  failed: number;
  /** Only reads, listings, searches and thinking. */
  explore: boolean;
  /** The newest step, which stays in view while the group is folded. */
  newest: string;
}

const exploring = new Set<StepKind>(["read", "list", "search", "think"]);

/** How one item counts for grouping; `retried` holds failed steps a later step re-ran. */
export function stepFact(item: Item, retried?: ReadonlySet<string>): StepFact {
  const base = {
    id: item.id,
    agentId: item.agentId ?? "",
    alone: false,
    running: false,
    failed: false,
  };
  switch (item.type) {
    case "reasoning":
      return { ...base, kind: "think", running: !item.complete };
    case "message":
      return { ...base, kind: "tool", alone: true, running: !item.complete };
    case "tool_call":
      break;
    default:
      return { ...base, kind: "tool", alone: true };
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

/** Each kind's phrase, mutating kinds first; exploration reads as one phrase. */
function phrases(facts: readonly StepFact[]): { text: string; steps: number }[] {
  const count = (kind: StepKind) => facts.filter((fact) => fact.kind === kind).length;
  const out: { text: string; steps: number }[] = [];
  const add = (steps: number, text: string) => {
    if (steps) out.push({ text, steps });
  };
  add(count("edit"), `edited ${plural(distinct(facts, "edit"), "file")}`);
  add(count("command"), `ran ${plural(count("command"), "command")}`);
  add(count("computer"), plural(count("computer"), "app step"));
  const sites = facts.some((fact) => fact.kind === "browser" && fact.target)
    ? distinct(
        facts.filter((fact) => fact.target),
        "browser",
      )
    : 0;
  add(
    count("browser"),
    sites ? `visited ${plural(sites, "site")}` : plural(count("browser"), "browser step"),
  );
  add(count("fetch"), `fetched ${plural(count("fetch"), "page")}`);
  add(count("websearch"), plural(count("websearch"), "web search", "web searches"));
  const reads = count("read");
  const searches = count("search");
  const lists = count("list");
  const explore = [
    reads ? `explored ${plural(distinct(facts, "read"), "file")}` : "",
    searches ? plural(searches, "search", "searches") : "",
    lists ? `listed ${plural(lists, "folder")}` : "",
  ].filter(Boolean);
  add(reads + searches + lists, explore.join(" · "));
  add(count("plan"), "updated the plan");
  add(count("spawn"), `started ${plural(count("spawn"), "subagent")}`);
  add(count("agent"), `messaged ${plural(count("agent"), "subagent")}`);
  add(count("tool"), `used ${plural(count("tool"), "tool")}`);
  return out;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Edited 2 files · ran 1 command · 3 other steps · 1 failed". */
export function groupSummary(facts: readonly StepFact[]): string {
  const named = phrases(facts);
  const parts = named.slice(0, 2).map((phrase) => phrase.text);
  const others = named.slice(2).reduce((total, phrase) => total + phrase.steps, 0);
  if (others) parts.push(plural(others, "other step"));
  if (!parts.length) {
    const thoughts = facts.filter((fact) => fact.kind === "think").length;
    parts.push(thoughts > 1 ? `Thought ${thoughts} times` : "Thought");
  }
  const failed = facts.filter((fact) => fact.failed).length;
  if (failed) parts.push(`${failed} failed`);
  return capital(parts.join(" · "));
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
    running: facts.some((fact) => fact.running),
    failed: facts.filter((fact) => fact.failed).length,
    explore: facts.every((fact) => exploring.has(fact.kind)),
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
    a.running === b.running &&
    a.failed === b.failed &&
    a.newest === b.newest &&
    a.ids.length === b.ids.length &&
    a.ids.every((id, index) => id === b.ids[index])
  );
}
