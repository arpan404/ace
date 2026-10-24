import type { ChangeTap, ThreadSource } from "@ace/client";
import type { Item } from "@ace/protocol";
import {
  turnHeadLabel,
  turnTreeOf,
  ledgerOf,
  startedThreadOf,
  subagentLabels,
  subagentStatusCounts,
  subagentStatusLine,
  agentName,
  blockRoom,
  closedMeta,
  closedQuestionWords,
  questionTitle,
  subagentDetail,
  subagentElapsed,
  subagentGroupStatus,
  subagentMeta,
  subagentSpan,
  subagentRunning,
  subagentTerminal,
  subagentToolId,
  providerSlots,
  summarizeWork,
  thoughtMs,
  workCounts,
  type SubagentGroupStatus,
  type SubagentState,
} from "@ace/ui-core";
import type { StatusToken } from "@ace/ui-core/mobile";
import { readSubagentGroup, type SubagentEntry } from "@ace/ui-core/subagent-group";
import { rootRunOf } from "@ace/ui-core";
import { createBlockReader } from "@ace/ui-core/transcript-block-reader";
import { blockItems, type Block } from "@ace/ui-core/transcript-blocks";
import { preview } from "./presentation.ts";
import { endingRow, filesRow } from "./turn-ending.ts";
import { backgroundRows } from "./background-rows.ts";
import { stepContext } from "./thread-rows.ts";
import { workLog, type LogFacts } from "./work-log.ts";
import { eventFollows, messageBlock, streamingOf } from "./thread-messages.ts";
import { anchoredOffset } from "./anchored-positions.ts";

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
  // Losing or regaining confirmation moves "Last seen" and live activity.
  key === "unconfirmed" ||
  key === "interactions" ||
  key === "tasks" ||
  // A background command ending moves its line in a running log.
  key.startsWith("task:") ||
  key.startsWith("agent:") ||
  key.startsWith("run:");

/** A branch's state as a key of the shared status palette (`@ace/ui-core/mobile`). */
const tokens: Record<SubagentState, StatusToken> = {
  working: "working",
  human: "needsYou",
  waiting: "waiting",
  queued: "neutral",
  unresponsive: "unresponsive",
  failed: "failed",
  cancelled: "neutral",
  done: "done",
};

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

const groupTokens: Record<SubagentGroupStatus, StatusToken> = {
  human: "needsYou",
  failed: "failed",
  working: "working",
  done: "done",
};

/** Ticking from `since` while it runs, else a settled duration; neither when hidden. */
function elapsedRow(elapsed: ReturnType<typeof subagentElapsed>) {
  return {
    since: elapsed && "since" in elapsed ? elapsed.since : null,
    elapsed: elapsed && "text" in elapsed ? elapsed.text : "",
  };
}

/** One subagent as the web's agent row: name and meta, status and time, then its detail line. */
function agentRow(store: ThreadSource, entry: SubagentEntry, fresh: boolean) {
  const agent = entry.agentId ? store.agent(entry.agentId) : undefined;
  const toolId = subagentToolId(agent);
  const tool = toolId ? store.item(toolId) : undefined;
  const { detail, kind } = subagentDetail(
    entry,
    agent,
    tool?.type === "tool_call" ? tool.call.title : undefined,
    fresh,
  );
  const terminal = subagentTerminal(entry.state);
  const status = subagentLabels[entry.state];
  return {
    id: entry.id,
    agentId: entry.agentId ?? "",
    threadId: entry.childThreadId ?? "",
    title: preview(entry.title, 256),
    state: entry.state,
    label: !fresh && !terminal ? `Last seen: ${status}` : status,
    token: tokens[entry.state],
    provider: entry.provider ?? "",
    model: preview(entry.model ?? "", 128),
    result: preview(entry.result ?? "", 512),
    meta: preview(subagentMeta(entry) ?? "", 128),
    machine: preview(entry.machine ?? "", 128),
    detail: preview(detail ?? "", 256),
    detailKind: kind ?? "",
    ...elapsedRow(subagentElapsed({ ...entry, running: subagentRunning(entry.state) }, fresh)),
  };
}

function subagents(store: ThreadSource, ids: readonly string[]) {
  const entries = readSubagentGroup(store, ids).value;
  const states = entries.map((entry) => entry.state);
  // A copy the daemon hasn't confirmed shows its last-seen states and never live activity.
  const fresh = store.unconfirmed !== true;
  const span = entries.length ? subagentSpan(entries) : undefined;
  const slots = providerSlots(entries.map((entry) => entry.provider));
  return {
    status: preview(subagentStatusLine(states), 256),
    title: `${entries.length} ${entries.length === 1 ? "subagent" : "subagents"}`,
    /** The group reads as its worst child: needs you, failed, working, done. */
    token: groupTokens[subagentGroupStatus(states)],
    /** "Last seen: " leads the counts while a running group's facts are stale. */
    stale: !fresh && span?.running === true,
    /** The status line's parts, worst first, each in its own status colour: "2 working". */
    counts: subagentStatusCounts(states).map((part) => ({
      text: `${part.count} ${part.word}`,
      token: tokens[part.state],
    })),
    /** Each provider once, in launch order, at most three slots; past three, "+N". */
    lead: {
      providers: slots.shown.map((provider) => provider ?? ""),
      more: slots.more,
      label: slots.label,
    },
    ...elapsedRow(span ? subagentElapsed(span, fresh) : undefined),
    entries: entries.slice(0, 32).map((entry) => agentRow(store, entry, fresh)),
  };
}

/**
 * A question where the agent asked it (the web's question line): "Codex is asking · title"
 * while it waits, its card on the composer; once closed, "Codex asked · title", its answer and
 * how it ended.
 */
function questionLine(store: ThreadSource, interactionId: string) {
  const interaction = store.interaction(interactionId);
  if (interaction?.request.kind !== "question") return null;
  const questions = interaction.request.questions;
  const agent = interaction.agentId ? store.agent(interaction.agentId) : undefined;
  const pending = interaction.state === "pending";
  const words = pending
    ? { answer: "", outcome: undefined }
    : closedQuestionWords(questions, interaction.resolution, closedMeta(interaction, false));
  return {
    asking: pending,
    asker: preview(agent ? agentName(agent) : "The agent", 128),
    title: preview(questionTitle(questions), 256),
    answer: preview(words.answer, 256),
    outcome: preview(words.outcome ?? "", 256),
  };
}

/** What a log of this thread reads with: its turns' ends, thoughts' times, steps' contexts. */
export function logFacts(store: ThreadSource): LogFacts {
  return {
    ended: (item: Item) => {
      const run = item.runId ? store.run(item.runId) : undefined;
      return run !== undefined && run.state !== "active";
    },
    took: (id) => thoughtMs(store, id),
    context: (item) => stepContext(store, item),
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
  const read = (id: string) => store.item(id);
  // A step whose turn is over is settled, whatever its stream last said.
  const facts = logFacts(store);
  const base = {
    index: index ?? null,
    kind: block.kind,
    /** The room it asks for above and below (`@ace/ui-core` row-room): 8, 16 or 24. */
    room: blockRoom(block.kind),
    items: [] as string[],
    headed: block.kind === "message" && block.headed === true,
    interactionId: "",
    work: null as ReturnType<typeof workSummary> | null,
    agents: null as ReturnType<typeof subagents> | null,
    ending: null as ReturnType<typeof endingRow> | null,
    files: null as ReturnType<typeof filesRow> | null,
    started: null as { threadId: string; title: string } | null,
    /** A settled work head's root turn, which `turn.steps` reads its full steps by. */
    ordinal: null as number | null,
  };
  switch (block.kind) {
    case "work": {
      const items = workItems(block);
      const background = backgroundRows(store, items);
      const log = workLog(items, read, { ...facts, background });
      return {
        ...base,
        items,
        work: workSummary(store, block, items),
        log: log.rows,
        background,
        aceSteps: log.ace,
        retried: log.retried,
        thoughts: log.thoughts,
        ordinal: block.outcome === undefined ? null : (turnOf(store, blockItems(block)) ?? null),
      };
    }
    case "subagents":
      return { ...base, items: [...block.itemIds], agents: subagents(store, block.itemIds) };
    case "question":
      return {
        ...base,
        items: [...blockItems(block)],
        interactionId: block.interactionId,
        question: questionLine(store, block.interactionId),
      };
    case "end": {
      const items = block.itemIds ?? [];
      // A usage-limit pause keeps the work it did, a tap away.
      const background = block.ending === "paused" ? backgroundRows(store, items) : [];
      const log = block.ending === "paused" ? workLog(items, read, { ...facts, background }) : null;
      return {
        ...base,
        items: [...items],
        ending: endingRow(store, block),
        log: log?.rows ?? null,
        background,
        aceSteps: log?.ace ?? [],
        retried: log?.retried ?? [],
        thoughts: log?.thoughts ?? [],
      };
    }
    case "files":
      return { ...base, items: [...block.itemIds], files: filesRow(store, block.itemIds) };
    case "started": {
      const started = startedThreadOf(store.item(block.itemId));
      return {
        ...base,
        items: [block.itemId],
        started: started
          ? {
              threadId: started.threadId,
              title: preview(started.title ?? (started.forked ? "Fork" : "New thread"), 256),
              /** "New thread" or "Fork": the row's meta, before the child is known. */
              label: started.forked ? "Fork" : "New thread",
              provider: started.provider ?? "",
              model: preview(started.model ?? "", 128),
            }
          : null,
      };
    }
    case "live":
      return base;
    default: {
      const items = [...blockItems(block)];
      return { ...base, items, ...messageBlock(store, block.kind, items[0]) };
    }
  }
}

/** Where a follower's blocks go: the thread's own transcript, or one native subagent's lane. */
export interface BlockScope {
  agentId: string;
}

/**
 * Follow a thread's blocks (or, with a scope, one agent's own blocks, grouped the same way):
 * the tap to call with every change after the item tap, and the blocks it last built. Call it
 * before subscribing the tap: blocks are regrouped inside the change, so the store's shared turn
 * tree and ledger must hear each change first, or a turn reads settled while its subagents work.
 */
export function followBlocks(
  store: ThreadSource,
  put: Put,
  scope?: BlockScope,
): { tap: ChangeTap; block(key: string): Block | undefined } {
  turnTreeOf(store);
  ledgerOf(store);
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
  /** Event blocks whose row reads the rows around it (×N, repeats). */
  const ordered = new Set<string>();
  /** An event block's one item → that block, which redraws when the item does. */
  const single = new Map<string, string>();
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
    ordered.delete(key);
    const block = blocks.get(key);
    if (block?.kind === "user" || block?.kind === "event" || block?.kind === "item")
      if (single.get(block.itemId) === key) single.delete(block.itemId);
    if (block?.kind === "work") for (const id of workItems(block)) counted.get(id)?.delete(key);
  };
  const remember = (block: Block) => {
    if (block.kind === "subagents" || block.kind === "live" || block.kind === "question")
      following.add(block.key);
    // An answer's streaming ends with its turn; its own deltas never touch the block.
    if (block.kind === "message" && streamingOf(store, store.item(block.itemId)))
      following.add(block.key);
    if (block.kind === "user" || block.kind === "event" || block.kind === "item") {
      single.set(block.itemId, block.key);
      if (eventFollows(store, block.kind, block.itemId)) ordered.add(block.key);
    }
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
    // The native transcript has no "Forked from" divider yet; it leaves the block out rather
    // than drawing an empty row.
    const shown = built.value.filter((block) => block.kind !== "forked");
    const offset = anchoredOffset(
      positions,
      shown.map((block) => block.key),
    );
    shown.forEach((block, at) => {
      const index = at - offset;
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
      ordered.clear();
      single.clear();
      rebuild(touched);
    } else {
      let regroup = false;
      for (const key of keys) {
        if (structural.has(key) || watch.has(key)) regroup = true;
        else if (key.startsWith("run:") || key.startsWith("agent:")) regroup = true;
        if (live(key)) for (const block of following) touched.add(block);
        if (key.startsWith("item:")) {
          const id = key.slice(5);
          for (const block of counted.get(id) ?? []) touched.add(block);
          const block = single.get(id);
          if (block) touched.add(block);
          // A launch updates in place to its child's status, outcome and result: its group
          // redraws, since no receipt row says it for the group (`buildBlocks`).
          for (const shownId of following) {
            const shown = blocks.get(shownId);
            if (shown?.kind === "subagents" && shown.itemIds.includes(id)) touched.add(shownId);
          }
        }
        if (key === "order") for (const block of ordered) touched.add(block);
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
