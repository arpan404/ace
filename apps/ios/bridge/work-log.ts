import type { Item } from "@ace/protocol";
import {
  backgroundGroup,
  groupSteps,
  thoughtLabel,
  type StepContext,
  type StepGroup,
} from "@ace/ui-core";
import { readAceLog, readWorkLog } from "@ace/ui-core/work-log-reading";
import type { backgroundRows } from "./background-rows.ts";
import { preview } from "./presentation.ts";
import { stepOf } from "./thread-rows.ts";

/*
 * A work log's rows as the web's work log draws them (`step-groups-view.tsx`), from the same
 * shared reading (`@ace/ui-core/work-log-reading`) and grouping: a run of steps as one sentence
 * row ("Edited 2 files and ran 1 command"), a lone step, a thought ("Thought for 12s"), what the
 * agent said between steps, and commands left running in the background as their own lines or
 * one group of them. ace's own audits fold into the call they record and are never a row. Each
 * step's own line travels on its item row; a row here carries only what the log as a whole
 * decides. Pure: what it needs of the thread comes in as `LogFacts`.
 */

/** Where a log's steps are read: the live thread, or a finished turn's steps from the daemon. */
export type ReadItem = (id: string) => Item | undefined;

export type LogRow =
  | { kind: "step"; id: string }
  | { kind: "thought"; id: string; label: string; done: boolean }
  | {
      kind: "group";
      id: string;
      items: string[];
      sentence: string;
      summary: string;
      failed: number;
      icon: string;
      running: boolean;
      /** The step in flight, which titles a running group in a live log. */
      active: string;
      /** "2 steps", after the live title. */
      count: string;
    }
  | {
      kind: "background";
      id: string;
      items: string[];
      /** "2 background tasks · 1 running", "Ran 3 background tasks"; empty for one task. */
      label: string;
      /** Call ids of the ended tasks, shown when the group opens. */
      listed: string[];
      /** Call ids of the tasks still running: each keeps its own line under the group. */
      runningIds: string[];
    };

/** The steps an ace call's earlier steps describe, worded as their log reads them. */
type AceSteps = { id: string; step: NonNullable<ReturnType<typeof stepOf>> }[];

function groupRow(group: StepGroup): LogRow {
  return {
    kind: "group",
    id: group.key,
    items: [...group.ids],
    sentence: preview(group.sentence, 256),
    summary: preview(group.summary, 256),
    failed: group.failed,
    icon: group.icon,
    running: group.running,
    active: group.active ?? group.newest,
    count: `${group.ids.length} steps`,
  };
}

type BackgroundLine = ReturnType<typeof backgroundRows>[number];

/** What a log needs of its thread beyond its items. */
export interface LogFacts {
  /** The item's turn is over: a step it left unfinished reads settled. */
  ended?: (item: Item) => boolean;
  /** Commands the log's calls left running in the background, by call. */
  background?: readonly BackgroundLine[];
  /** How long a finished thought took, in ms, when known. */
  took?: (id: string) => number | undefined;
  /** Where an item's agent works and the approval that gated it. */
  context?: (item: Item) => StepContext;
}

export interface WorkLog {
  rows: LogRow[];
  /** Failed steps a later step ran again with success: drawn as neither failed nor noted. */
  retried: string[];
  /** Every thought's header, by item: "Thinking…", "Thought for 12s". */
  thoughts: { id: string; label: string; done: boolean }[];
  /** ace's own steps, worded with what earlier steps of the log said about them. */
  ace: AceSteps;
}

/** A log of `ids` (in order), read through `read`. */
export function workLog(ids: readonly string[], read: ReadItem, facts: LogFacts = {}): WorkLog {
  const ended = facts.ended ?? (() => false);
  const items = ids.map(read);
  const ace = readAceLog(items);
  const shown = ace.hidden.size ? ids.filter((id) => !ace.hidden.has(id)) : ids;
  const tasks = new Map((facts.background ?? []).map((line) => [line.itemId, line]));
  const reading = readWorkLog(ace.hidden.size ? shown.map(read) : items, tasks);
  // A step its ended turn left unfinished reads settled.
  const steps =
    reading.facts.filter((fact) => !fact.running).length === reading.facts.length
      ? reading.facts
      : reading.facts.map((fact) => {
          const item = fact.running ? read(fact.id) : undefined;
          return item && ended(item) ? Object.assign({}, fact, { running: false }) : fact;
        });
  const rows = groupSteps(steps).groups.map((group): LogRow => {
    if (group.icon === "background") {
      const counted = backgroundGroup(group.ids.map((id) => tasks.get(id)));
      const at = (index: number) => group.ids[index] ?? "";
      return {
        kind: "background",
        id: group.key,
        items: [...group.ids],
        label: group.ids.length > 1 ? counted.label : "",
        listed: counted.listed.map(at),
        runningIds: counted.running.map(at),
      };
    }
    if (group.single && group.icon === "think") {
      const item = read(group.key);
      const done = item?.type === "reasoning" && (item.complete || ended(item));
      return {
        kind: "thought",
        id: group.key,
        done,
        label: thoughtLabel(done, done ? facts.took?.(group.key) : undefined),
      };
    }
    return group.single ? { kind: "step", id: group.key } : groupRow(group);
  });
  // A thought in flight with no words yet is the log's live state, never a step (`readWorkLog`):
  // it titles the last group, or reads "Thinking…" before the first step, so the rows above
  // never regroup for it and the last row keeps its kind and id.
  const thinking = reading.thinking === undefined ? undefined : read(reading.thinking);
  if (thinking && !ended(thinking)) {
    const last = rows.at(-1);
    if (!last)
      rows.push({
        kind: "thought",
        id: thinking.id,
        done: false,
        label: thoughtLabel(false, undefined),
      });
    else if (last.kind === "group")
      rows[rows.length - 1] = { ...last, running: true, active: thinking.id };
  }
  const worded: AceSteps = [];
  for (const [id, context] of Object.entries(ace.contexts)) {
    const item = read(id);
    const step = item && stepOf(item, { ...facts.context?.(item), ace: context });
    if (step) worded.push({ id, step });
  }
  const thoughts = [];
  for (const id of shown) {
    const item = read(id);
    if (item?.type !== "reasoning") continue;
    const done = item.complete || ended(item);
    thoughts.push({ id, done, label: thoughtLabel(done, done ? facts.took?.(id) : undefined) });
  }
  return { rows, retried: [...reading.retried], thoughts, ace: worded };
}
