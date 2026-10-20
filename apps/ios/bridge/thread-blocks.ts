import type { ChangeTap, ThreadSource } from "@ace/client";
import {
  turnHeadLabel,
  ledgerOf,
  startedThreadOf,
  subagentLabels,
  subagentStatusLine,
  summarizeWork,
  workCounts,
  type SubagentState,
} from "@ace/ui-core";
import type { StatusToken } from "@ace/ui-core/mobile";
import { readSubagentGroup } from "@ace/ui-core/subagent-group";
import { rootRunOf } from "@ace/ui-core";
import { createBlockReader } from "@ace/ui-core/transcript-block-reader";
import { blockItems, type Block } from "@ace/ui-core/transcript-blocks";
import { preview } from "./presentation.ts";

/*
 * The transcript's blocks as the web builds them (`@ace/ui-core` transcript grouping): "Worked
 * for" heads over a turn's steps, subagent groups, questions and turn endings. Blocks re-derive
 * only when membership, runs, agents, tasks or interactions change, never on a streamed delta,
 * and each changed block is one patch: streaming touches its item row alone.
 */

type Put = (key: string, read: () => Record<string, unknown> | undefined) => void;
type WorkBlock = Extract<Block, { kind: "work" }>;

/** Keys whose change can regroup the transcript (the web's `useBlockKeys`). */
const structural = new Set(["order", "tasks", "interactions", "agents", "thread", "queue"]);
/** Keys whose change can alter a still-running head or a subagent group's states. */
const live = (key: string) =>
  key === "agents" ||
  key === "interactions" ||
  key === "tasks" ||
  key.startsWith("agent:") ||
  key.startsWith("run:");

/** A branch's state as a key of the shared status palette (`@ace/ui-core/mobile`). */
const tokens: Record<SubagentState, StatusToken> = {
  working: "working",
  human: "needsYou",
  waiting: "waiting",
  unresponsive: "unresponsive",
  failed: "failed",
  cancelled: "neutral",
  done: "done",
};
const endings = { failed: "Turn failed", interrupted: "Stopped", paused: "Paused · Usage limit" };

/** A folded head's steps, without the answer shown under it. */
function workItems(block: WorkBlock): string[] {
  const answers = new Set(block.answerIds ?? []);
  return blockItems(block).filter((id) => !answers.has(id));
}

function workSummary(store: ThreadSource, block: WorkBlock, ids: readonly string[]) {
  const summary = summarizeWork(ids.map((id) => store.item(id)));
  const from = block.startedAt ?? summary.startedAt;
  const to = block.until ?? summary.endedAt;
  const waited = to > from ? ledgerOf(store).waitedWithin(from, to) : 0;
  const ongoing = block.ongoing === true || (block.outcome === undefined && summary.running);
  return {
    label: turnHeadLabel(
      block.outcome,
      block.restarted === true,
      to - from - waited - (block.idle ?? 0),
    ),
    counts: preview(workCounts(summary), 256),
    current: preview(ongoing ? (summary.current ?? "") : "", 256),
    ongoing,
    outcome: block.outcome ?? "",
    startedAt: from,
    failed: summary.failed,
  };
}

function subagents(store: ThreadSource, ids: readonly string[]) {
  const entries = readSubagentGroup(store, ids).value;
  return {
    status: preview(subagentStatusLine(entries.map((entry) => entry.state)), 256),
    entries: entries.slice(0, 32).map((entry) => ({
      id: entry.id,
      agentId: entry.agentId ?? "",
      threadId: entry.childThreadId ?? "",
      title: preview(entry.title, 256),
      state: entry.state,
      label: subagentLabels[entry.state],
      token: tokens[entry.state],
      provider: entry.provider ?? "",
      model: preview(entry.model ?? "", 128),
      result: preview(entry.result ?? "", 512),
    })),
  };
}

/** The root turn a block's items belong to: the first item whose run is still known. */
function turnOf(store: ThreadSource, ids: readonly string[]): number | undefined {
  for (const id of ids) {
    const ordinal = rootRunOf(store, store.item(id)?.runId)?.ordinal;
    if (ordinal !== undefined) return ordinal;
  }
  return undefined;
}

export function blockRow(store: ThreadSource, block: Block, index: number | undefined) {
  const base = {
    index: index ?? null,
    kind: block.kind,
    items: [] as string[],
    headed: block.kind === "message" && block.headed === true,
    interactionId: "",
    work: null as ReturnType<typeof workSummary> | null,
    agents: null as ReturnType<typeof subagents> | null,
    ending: null as { label: string; automatic: boolean; error: string } | null,
    started: null as { threadId: string; title: string } | null,
    /** A settled work head's root turn, which `turn.steps` reads its full steps by. */
    ordinal: null as number | null,
  };
  switch (block.kind) {
    case "work": {
      const items = workItems(block);
      return {
        ...base,
        items,
        work: workSummary(store, block, items),
        ordinal: block.outcome === undefined ? null : (turnOf(store, blockItems(block)) ?? null),
      };
    }
    case "subagents":
      return { ...base, items: [...block.itemIds], agents: subagents(store, block.itemIds) };
    case "question":
      return { ...base, items: [...blockItems(block)], interactionId: block.interactionId };
    case "end": {
      const error = block.errorId ? store.item(block.errorId) : undefined;
      return {
        ...base,
        ending: {
          // A restart, not the person, cut it short.
          label:
            block.ending === "interrupted" && block.automatic
              ? "Interrupted"
              : endings[block.ending],
          automatic: block.automatic === true,
          error: preview(error?.type === "notice" ? error.text : "", 512),
        },
      };
    }
    case "started": {
      const started = startedThreadOf(store.item(block.itemId));
      return {
        ...base,
        items: [block.itemId],
        started: started
          ? { threadId: started.threadId, title: preview(started.title ?? "Conversation", 256) }
          : null,
      };
    }
    case "live":
      return base;
    default:
      return { ...base, items: [...blockItems(block)] };
  }
}

/** Where a follower's blocks go: the thread's own transcript, or one native subagent's lane. */
export interface BlockScope {
  agentId: string;
}

/**
 * Follow a thread's blocks (or, with a scope, one agent's own blocks, grouped the same way):
 * the tap to call with every change after the item tap, and the blocks it last built.
 */
export function followBlocks(
  store: ThreadSource,
  put: Put,
  scope?: BlockScope,
): { tap: ChangeTap; block(key: string): Block | undefined } {
  const read = createBlockReader(scope?.agentId);
  const type = scope ? "thread.laneBlock" : "thread.block";
  const prefix = scope ? `lane:${scope.agentId}:` : "";
  const lane = scope ? { lane: scope.agentId } : {};
  let blocks = new Map<string, Block>();
  const positions = new Map<string, number>();
  let watch: ReadonlySet<string> = new Set();
  /** Item → settled heads that count it; their summary moves when the step does. */
  const counted = new Map<string, Set<string>>();
  /** Blocks whose display follows agent, run and interaction state. */
  const following = new Set<string>();
  const emit = (key: string) =>
    put(`${prefix}block:${key}`, () => {
      const block = blocks.get(key);
      return {
        type,
        ...lane,
        id: key,
        row: block ? blockRow(store, block, positions.get(key)) : null,
      };
    });
  const forget = (key: string) => {
    following.delete(key);
    const block = blocks.get(key);
    if (block?.kind === "work") for (const id of workItems(block)) counted.get(id)?.delete(key);
  };
  const remember = (block: Block) => {
    if (block.kind === "subagents" || block.kind === "live" || block.kind === "question")
      following.add(block.key);
    if (block.kind !== "work") return;
    if (block.ongoing || block.outcome === undefined) following.add(block.key);
    for (const id of workItems(block))
      if (store.item(id)?.type !== "message") {
        let keys = counted.get(id);
        if (!keys) counted.set(id, (keys = new Set()));
        keys.add(block.key);
      }
  };
  const rebuild = (touched: Set<string>) => {
    const built = read(store);
    watch = new Set(built.watch);
    const next = new Map<string, Block>();
    built.value.forEach((block, index) => {
      next.set(block.key, block);
      const old = blocks.get(block.key);
      const moved = positions.get(block.key) !== index;
      positions.set(block.key, index);
      if (old === block && !moved) return;
      if (old !== block) {
        forget(block.key);
        touched.add(block.key);
      } else
        put(`${prefix}blockPosition:${block.key}`, () => ({
          type: `${type}Position`,
          ...lane,
          id: block.key,
          index: positions.get(block.key) ?? null,
        }));
    });
    for (const key of blocks.keys())
      if (!next.has(key)) {
        forget(key);
        positions.delete(key);
        touched.add(key);
      }
    blocks = next;
    for (const key of touched) {
      const block = blocks.get(key);
      if (block) remember(block);
    }
  };
  const tap: ChangeTap = (keys) => {
    const touched = new Set<string>();
    if (keys === "all") {
      blocks = new Map();
      positions.clear();
      counted.clear();
      following.clear();
      rebuild(touched);
    } else {
      let regroup = false;
      for (const key of keys) {
        if (structural.has(key) || watch.has(key)) regroup = true;
        else if (key.startsWith("run:") || key.startsWith("agent:")) regroup = true;
        if (live(key)) for (const block of following) touched.add(block);
        if (key.startsWith("item:"))
          for (const block of counted.get(key.slice(5)) ?? []) touched.add(block);
        if (key.startsWith("interaction:"))
          for (const block of following)
            if (blocks.get(block)?.kind === "question") touched.add(block);
      }
      if (regroup) rebuild(touched);
    }
    for (const key of touched) emit(key);
  };
  return { tap, block: (key) => blocks.get(key) };
}
