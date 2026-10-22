import { toolSurface } from "@ace/projection";
import type { Item, ToolSurface } from "@ace/protocol";
import { aceCallOf, aceToolLog, screenStep, type AceLog } from "./ace-tool-rows.ts";
import { backgroundFact, sameFact, stepFact, type StepFact } from "./step-groups.ts";
import { toolRefusal } from "./tool-refusals.ts";
import { retriedStepIds } from "./work-log.ts";

/*
 * A work log read as a whole, as every client shows it: which of its items are steps and how
 * each counts for grouping (a call that left a command running counts as a background task),
 * which failed steps a later step ran again with success, the surface each browser or
 * computer-use step drove, and ace's own steps (what each acted on, the daemon's audits folded
 * into the call they record). Items change by replacement, so per-item reads are memoised by
 * object. Pure.
 */

const facts = new WeakMap<Item, StepFact | null>();
const surfaces = new WeakMap<Item, ToolSurface | null>();
const aceItems = new WeakMap<Item, boolean>();

function factOf(item: Item): StepFact | undefined {
  let fact = facts.get(item);
  if (fact === undefined) {
    fact = stepFact(item) ?? null;
    facts.set(item, fact);
  }
  return fact ?? undefined;
}

function surfaceOf(item: Item): ToolSurface | undefined {
  let surface = surfaces.get(item);
  if (surface === undefined) {
    surface = item.type === "tool_call" ? (toolSurface(item.call) ?? null) : null;
    surfaces.set(item, surface);
  }
  return surface ?? undefined;
}

const noIds: ReadonlySet<string> = new Set();

export interface WorkLogReading {
  facts: readonly StepFact[];
  /** Each step's surface, a URL-less browser step on the site its agent was last on. */
  surfaces: ReadonlyMap<string, ToolSurface>;
  /** Failed steps a later step ran again with success: not shown as failed. */
  retried: ReadonlySet<string>;
}

/** The log's facts; `calls` are its calls that left a command running in the background. */
export function readWorkLog(
  items: readonly (Item | undefined)[],
  calls: ReadonlyMap<string, string> | ReadonlySet<string>,
): WorkLogReading {
  const loaded = items.filter((item): item is Item => item !== undefined);
  // Only a log with a failure looks for retries: the common case reads each item once.
  const retried = loaded.some((item) => factOf(item)?.failed) ? retriedStepIds(loaded) : undefined;
  const out: StepFact[] = [];
  const shown = new Map<string, ToolSurface>();
  const sites = new Map<string, string>();
  for (const item of loaded) {
    const known = factOf(item);
    if (!known) continue;
    const fact = calls.has(item.id) ? backgroundFact(known) : known;
    out.push(retried?.has(item.id) ? { ...fact, failed: false } : fact);
    const surface = surfaceOf(item);
    if (!surface) continue;
    const agent = item.agentId ?? "";
    const carried = sites.get(agent);
    const drawn =
      surface.kind === "browser" && !surface.icon && carried
        ? { ...surface, icon: { kind: "site" as const, origin: carried } }
        : surface;
    if (drawn.icon?.kind === "site") sites.set(agent, drawn.icon.origin);
    shown.set(item.id, drawn);
  }
  return { facts: out, surfaces: shown, retried: retried ?? noIds };
}

export const sameWorkLogReading = (a: WorkLogReading, b: WorkLogReading) =>
  a.retried.size === b.retried.size &&
  [...a.retried].every((id) => b.retried.has(id)) &&
  a.facts.length === b.facts.length &&
  a.facts.every((fact, index) => sameFact(fact, b.facts[index] ?? fact)) &&
  a.surfaces.size === b.surfaces.size &&
  [...a.surfaces].every(([id, surface]) => {
    const other = b.surfaces.get(id);
    return (
      other?.kind === surface.kind &&
      JSON.stringify(other.icon) === JSON.stringify(surface.icon) &&
      other.iconRef === surface.iconRef
    );
  });

/** Whether an item is one of ace's own steps, or the daemon's audit or failure report of one. */
function isAce(item: Item): boolean {
  let known = aceItems.get(item);
  if (known === undefined) {
    known = !!screenStep(item) || !!aceCallOf(item) || !!toolRefusal(item);
    aceItems.set(item, known);
  }
  return known;
}

/** ace's steps in a log: what each acted on, and the audits folded into the call they record. */
export interface AceReading {
  contexts: AceLog["contexts"];
  /** Audits folded into their calls: never a row of their own. */
  hidden: ReadonlySet<string>;
  signature: string;
}

const noAce: AceReading = { contexts: {}, hidden: new Set(), signature: "" };

export const sameAceReading = (a: AceReading, b: AceReading) => a.signature === b.signature;

export function readAceLog(items: readonly (Item | undefined)[]): AceReading {
  const ace = items.filter((item): item is Item => !!item && isAce(item));
  if (!ace.length) return noAce;
  // Only ace's own steps feed its reading, so a log of other tools costs nothing here.
  const log = aceToolLog(
    ace.map((item) => item.id),
    ace,
  );
  const shown = new Set(log.rows.flatMap((row) => (row.kind === "group" ? row.ids : [row.id])));
  const hidden = new Set(ace.flatMap((item) => (shown.has(item.id) ? [] : [item.id])));
  return { contexts: log.contexts, hidden, signature: log.signature };
}
