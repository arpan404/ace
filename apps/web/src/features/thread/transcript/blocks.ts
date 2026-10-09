import { visibleHistoryOrder } from "@ace/projection";
import { executionOrder } from "./execution-order.ts";
import type { Item, Run } from "@ace/protocol";
import {
  carriesOnStretch,
  isBareErrorCode,
  reviewedInteraction,
  type InlineQuestion,
} from "@ace/ui-core";

export { isInlineInteraction } from "@ace/ui-core";

/**
 * The transcript reads like a document: a turn's tool work collapses into one "Worked for" line
 * and its spawns into one "Started N subagents" line (subagents' own work interleaves with the
 * parent's, so these are per turn, not per run of adjacent items). What the agent says between
 * steps sits inside that log, in order; what it says after its last step is the answer, shown
 * below it. Background tasks, questions and notices show where they happened without opening a
 * second log, and a run the agent starts by itself when its background work finishes carries
 * the same log on. Once a turn's whole tree has settled, one changed-files card follows its
 * last answer, and a turn that failed, was stopped or was paused by a usage limit says so after
 * its last block. Blocks
 * depend on item order, kinds and links, background calls, inline questions and how turns
 * ended, never on a streamed delta, so streaming never regroups the transcript.
 *
 * Contract C-B (UX audit): `question` and `event` blocks are rendered by the step and event
 * renderers (`items/`); the transcript only decides where they sit.
 */
export type Block =
  | { kind: "user"; key: string; itemId: string }
  | { kind: "message"; key: string; itemId: string }
  /**
   * A turn's tool work, with what the agent said between its steps, in order. `until` is the
   * moment the stretch closed (the agent answered, the person wrote, the turn ended): its
   * "Worked for" never runs past it, whatever settles later.
   */
  | {
      kind: "work";
      key: string;
      itemIds: string[];
      until?: number | undefined;
      ongoing?: boolean | undefined;
      /**
       * Time the agent sat idle inside the log, between a turn's end and the run it started by
       * itself when its background work or subagent finished: not counted as work.
       */
      idle?: number | undefined;
    }
  | { kind: "subagents"; key: string; itemIds: string[] }
  | { kind: "background"; key: string; itemId: string; taskId: string }
  | { kind: "files"; key: string; itemIds: string[] }
  | { kind: "item"; key: string; itemId: string }
  /**
   * A question the agent asked the person, where it was asked: pending or answered, never
   * folded into a work log. `itemId` is the tool call it was asked from (its `ask_user` step,
   * which the block replaces), when that call is loaded; `anchorId` the item it sits after.
   */
  | {
      kind: "question";
      key: string;
      interactionId: string;
      itemId?: string | undefined;
      anchorId?: string | undefined;
    }
  /**
   * A message ace or the provider injected rather than the person typed (synthetic today; the
   * message `origin` once it lands): a quiet event, never a bubble.
   */
  | { kind: "event"; key: string; itemId: string }
  /**
   * How a turn that didn't simply complete ended, kept in history: "Turn failed" with its
   * reason, "Stopped", or a usage-limit pause. `runId` is the root turn's run, when known;
   * `askId` the person's message that started it; `automatic` that ace, not the person, stopped
   * it (a restart or limit resume followed); `latest` that it is the newest turn in view.
   * `errorId` is the error notice that reported the failure: the ending shows it, and the notice
   * has no row of its own, so one failure is one row (QA-10).
   */
  | {
      kind: "end";
      key: string;
      ending: "failed" | "interrupted" | "paused";
      runId: string | undefined;
      askId: string | undefined;
      automatic?: boolean | undefined;
      latest?: boolean | undefined;
      errorId?: string | undefined;
    };

/** What the blocks need of a run. */
export type RunFacts = Pick<Run, "state" | "trigger" | "endedAt"> & {
  startedAt?: number | undefined;
  /** The run's failure, once the daemon reports it on the run (C-A). */
  failedOn?: string | undefined;
};

export interface BlockSource {
  order: readonly string[];
  item(id: string): Item | undefined;
  /** Tool call id → background task id, for calls that outlived their turn. */
  background: ReadonlyMap<string, string>;
  /** Interactions that render inline (questions), oldest first. */
  questions?: readonly InlineQuestion[];
  /** The turn (the root agent's run) an item belongs to, where known. */
  turnOf?(itemId: string): string | undefined;
  /** A run's state, trigger and end. */
  run?(runId: string): RunFacts | undefined;
  /** Whether a spawned agent has finished its part of the turn. */
  agentSettled?(agentId: string): boolean;
  /** The tool call an interaction was raised from, for ace's review notices. */
  reviewedCall?(interactionId: string): string | undefined;
  /** The turn a usage limit holds right now, and turns seen held earlier. */
  heldTurn?: string | undefined;
  pausedTurns?: ReadonlySet<string>;
  /** The agent stopped or failed in a turn none of whose output is loaded. */
  stoppedTail?: "failed" | "interrupted" | "paused" | undefined;
  /** The owner is still active when the newest output has no known root turn. */
  unsettledTail?: boolean | undefined;
  /** Filled with the runs and agents whose settling would change the blocks. */
  watch?: { runs: Set<string>; agents: Set<string> };
}

const editKinds = new Set(["file.edit", "file.write", "file.delete", "file.move"]);

/** The last index in `order` whose item was created at or before `at`. O(log n). */
function lastAtOrBefore(source: BlockSource, at: number): number {
  let low = 0;
  let high = source.order.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const created = source.item(source.order[middle] ?? "")?.createdAt ?? Number.POSITIVE_INFINITY;
    if (created <= at) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/**
 * Where each inline interaction sits: after the item it was asked from, else after the last
 * item that existed when it was asked. Interactions older than the loaded window are left out
 * (a pending one stays in the live footer).
 */
function anchorQuestions(source: BlockSource): Map<string, string[]> {
  const anchors = new Map<string, string[]>();
  const questions = source.questions ?? [];
  if (!questions.length || !source.order.length) return anchors;
  const firstAt = source.item(source.order[0] ?? "")?.createdAt ?? Number.POSITIVE_INFINITY;
  for (const question of questions) {
    let anchor: string | undefined;
    if (question.toolCallId && source.item(question.toolCallId)) anchor = question.toolCallId;
    else if (question.createdAt >= firstAt)
      anchor = source.order[lastAtOrBefore(source, question.createdAt)];
    if (anchor === undefined) continue;
    const list = anchors.get(anchor);
    if (list) list.push(question.id);
    else anchors.set(anchor, [question.id]);
  }
  return anchors;
}

/** What the blocks remember of one turn while building. */
interface TurnMark {
  id: string;
  /** The person's message that started it. */
  askId: string | undefined;
  edits: string[];
  /** Index of its last assistant message's block, and of its last block. */
  lastMessage: number;
  lastBlock: number;
  /** Every run of its tree, and the agents it spawned (whose runs may not have started). */
  runs: Set<string>;
  agents: Set<string>;
  /** Its work log still open when it ended, to freeze at the turn's end. */
  openWork: Extract<Block, { kind: "work" }> | undefined;
  work: WorkBlock[];
  /** A usage limit paused it (the next turn resumed after the limit, or it was seen held). */
  paused: boolean;
  /** The turn after it started by itself (a restart or limit resume). */
  automatic: boolean;
  /** Its last error notice with a row of its own, with no answer after it: what a failure says. */
  failure: { index: number; itemId: string } | undefined;
}

type WorkBlock = Extract<Block, { kind: "work" }>;

/** The person's own words: not a message ace or the provider wrote for them. */
const isPerson = (item: Item) => item.type === "message" && item.role === "user" && !item.synthetic;

/**
 * Whether turn `next` carries on the stretch before it: the agent started it by itself once its
 * background work or a subagent finished (no one asked), so it opens no second log.
 */
function continues(source: BlockSource, next: string): boolean {
  return carriesOnStretch(source.run?.(next)?.trigger);
}

/** Whether an item goes into a work log (when it is not shown as a question instead). */
function joinsWork(item: Item, source: BlockSource): boolean {
  switch (item.type) {
    case "tool_call":
      return !source.background.has(item.id) && item.call.kind !== "agent.spawn";
    case "reasoning":
      return true;
    case "notice": {
      // Output or a review of a step joins that step's log (as `buildBlocks` places it).
      if (item.measurement || item.toolCallId) return true;
      const reviewed = reviewedInteraction(item);
      return !!reviewed && !!source.reviewedCall?.(reviewed);
    }
    default:
      return false;
  }
}

/**
 * For each stretch (a turn's output between two of the person's messages), the position of its
 * last item that goes into a work log. The agent's words before it are said between steps and
 * join the log; the words after it are the answer. One pass, as `buildBlocks` walks.
 */
function lastWorkOf(
  order: readonly string[],
  source: BlockSource,
  anchors: ReadonlyMap<string, readonly string[]>,
): { stretchAt: Int32Array; lastWork: Map<number, number> } {
  const stretchAt = new Int32Array(order.length);
  const lastWork = new Map<number, number>();
  let stretch = 0;
  let turn: string | undefined;
  let ask: string | undefined;
  for (const [index, id] of order.entries()) {
    const item = source.item(id);
    if (!item) continue;
    if (isPerson(item)) {
      ask = id;
      turn = undefined;
      stretch++;
    } else {
      const next = source.turnOf?.(id) ?? turn ?? (ask === undefined ? "" : `ask:${ask}`);
      if (next !== turn) {
        if (turn !== undefined && !continues(source, next)) stretch++;
        turn = next;
      }
    }
    stretchAt[index] = stretch;
    const question =
      anchors.has(id) && item.type === "tool_call" && item.call.detail.kind === "ask_user";
    if (!question && joinsWork(item, source)) lastWork.set(stretch, index);
  }
  return { stretchAt, lastWork };
}

/**
 * The transcript's blocks. A stretch of work (one "Worked for" log, one "Started N subagents"
 * line) is a turn's output until its answer or the person's next message, never across turns:
 * the agent's words between steps join the log in order, and notices, background tasks,
 * questions, injected messages and other events show inline without ending it. A turn's files
 * card and ending wait until its whole tree has settled (ADR 0062).
 */
export function buildBlocks(source: BlockSource): Block[] {
  const blocks: Block[] = [];
  const anchors = anchorQuestions(source);
  const order = visibleHistoryOrder(executionOrder(source), source.item);
  const { stretchAt, lastWork } = lastWorkOf(order, source, anchors);
  const turns = new Map<string, TurnMark>();
  const ordered: TurnMark[] = [];
  let stretch: { work?: { block: WorkBlock; at: number }; subagents?: { itemIds: string[] } } = {};
  const groupOf = new Map<string, { itemIds: string[]; at: number }>();
  let turnId: string | undefined;
  let askId: string | undefined;
  let mark: TurnMark | undefined;
  const markOf = (id: string, ask: string | undefined) => {
    let found = turns.get(id);
    if (!found) {
      found = {
        id,
        askId: ask,
        edits: [],
        lastMessage: -1,
        lastBlock: -1,
        runs: new Set(),
        agents: new Set(),
        openWork: undefined,
        work: [],
        paused: false,
        automatic: false,
        failure: undefined,
      };
      // A turn ace started after the previous one stopped (a restart, a limit resume).
      const trigger = source.run?.(id)?.trigger;
      const previous = ordered.at(-1);
      if (previous && (trigger === "limit_resume" || trigger === "restart")) {
        previous.automatic = true;
        if (trigger === "limit_resume") previous.paused = true;
      }
      turns.set(id, found);
      ordered.push(found);
    }
    return found;
  };
  const placed = (index: number, message = false) => {
    if (!mark) return;
    mark.lastBlock = Math.max(mark.lastBlock, index);
    if (message) mark.lastMessage = index;
  };
  /** End the stretch; its work log stops counting at `at`. */
  const close = (at: number | undefined) => {
    const work = stretch.work;
    if (work && at !== undefined) work.block.until = at;
    if (mark && work && at === undefined) mark.openWork = work.block;
    stretch = {};
  };
  const group = (kind: "work" | "subagents", id: string) => {
    if (kind === "subagents") {
      let open = stretch.subagents;
      if (!open) {
        const itemIds: string[] = [];
        blocks.push({ kind, key: `${kind}:${id}`, itemIds });
        open = stretch.subagents = { itemIds };
      }
      open.itemIds.push(id);
      placed(blocks.length - 1);
      return;
    }
    let open = stretch.work;
    if (!open) {
      const block: WorkBlock = { kind, key: `${kind}:${id}`, itemIds: [] };
      open = stretch.work = { block, at: blocks.push(block) - 1 };
      mark?.work.push(block);
    }
    open.block.itemIds.push(id);
    groupOf.set(id, { itemIds: open.block.itemIds, at: open.at });
    placed(open.at);
  };
  const push = (block: Block, closesAt: number | undefined | false, message = false) => {
    if (closesAt !== false) close(closesAt);
    blocks.push(block);
    placed(blocks.length - 1, message);
  };
  const reviewsPlaced = new Map<string, number>();
  for (const [index, id] of order.entries()) {
    const item = source.item(id);
    if (!item) continue;
    const person = isPerson(item);
    const known = source.turnOf?.(id);
    if (person) {
      // The person's message belongs to the turn that answers it.
      askId = id;
      mark = undefined;
      turnId = undefined;
    } else {
      const next = known ?? turnId ?? (askId === undefined ? "" : `ask:${askId}`);
      if (next !== turnId) {
        if (turnId === undefined || !continues(source, next)) {
          if (turnId !== undefined) close(item.createdAt);
        } else if (stretch.work) {
          // The log carries on into the run the agent started by itself; the wait between the
          // two runs was no work.
          const ended = source.run?.(turnId)?.endedAt;
          const started = source.run?.(next)?.startedAt;
          if (ended !== undefined && started !== undefined && started > ended)
            stretch.work.block.idle = (stretch.work.block.idle ?? 0) + started - ended;
        }
        turnId = next;
        mark = markOf(next, askId);
      }
      if (item.runId) mark?.runs.add(item.runId);
    }
    const asked = anchors.get(id);
    // A question's own step: the question block stands in for it.
    const replaced =
      !!asked && item.type === "tool_call" && item.call.detail.kind === "ask_user" ? id : undefined;
    if (!replaced)
      switch (item.type) {
        case "message":
          if (item.synthetic) push({ kind: "event", key: id, itemId: id }, false);
          else if (person) push({ kind: "user", key: id, itemId: id }, item.createdAt);
          else {
            // Said between steps: it reads inside the log, in order. After the last step: the
            // answer, below the log.
            const between = (lastWork.get(stretchAt[index] ?? -1) ?? -1) > index;
            if (between) group("work", id);
            else
              push(
                { kind: "message", key: id, itemId: id },
                item.complete ? item.createdAt : false,
                true,
              );
            // The agent spoke after the error: that error was not how the turn ended.
            if (mark) mark.failure = undefined;
          }
          break;
        case "tool_call": {
          const taskId = source.background.get(id);
          if (taskId !== undefined)
            push({ kind: "background", key: id, itemId: id, taskId }, false);
          else if (item.call.kind === "agent.spawn") {
            group("subagents", id);
            if (item.call.detail.kind === "agent.spawn" && item.call.detail.childAgentId)
              mark?.agents.add(item.call.detail.childAgentId);
          } else {
            group("work", id);
            if (editKinds.has(item.call.kind)) mark?.edits.push(id);
          }
          break;
        }
        case "reasoning":
          group("work", id);
          break;
        case "notice": {
          // A measurement, or the daemon's audit of a computer-use action: both are steps of the
          // work, and the log folds an audit into the call it records.
          if (item.measurement || item.code === "screen.step") {
            group("work", id);
            break;
          }
          // Output or a review of a step joins that step's log, right after the step.
          const reviewed = reviewedInteraction(item);
          const callId = item.toolCallId ?? (reviewed && source.reviewedCall?.(reviewed));
          const host = callId ? groupOf.get(callId) : undefined;
          if (callId && host) {
            const after = (reviewsPlaced.get(callId) ?? 0) + 1;
            host.itemIds.splice(host.itemIds.indexOf(callId) + after, 0, id);
            reviewsPlaced.set(callId, after);
            groupOf.set(id, host);
            placed(host.at);
          } else if (callId) group("work", id);
          else {
            push({ kind: "item", key: id, itemId: id }, false);
            if (mark && item.level === "error" && !isBareErrorCode(item.text))
              mark.failure = { index: blocks.length - 1, itemId: id };
          }
          break;
        }
        default:
          push({ kind: "item", key: id, itemId: id }, false);
      }
    // A turn with no output yet is anchored on the person's message that started it.
    if (person && known !== undefined && !turns.has(known)) {
      const own = markOf(known, id);
      own.runs.add(known);
      own.lastBlock = blocks.length - 1;
    } else if (person && known === undefined && !turns.has(`ask:${id}`)) {
      // An ask the daemon admitted before its turn started (SY-1) has no run yet: it is still
      // the newest turn's, so the one before it is history.
      markOf(`ask:${id}`, id).lastBlock = blocks.length - 1;
    }
    // A question sits where it was asked; the turn's work goes on in the same log after it.
    for (const interactionId of asked ?? [])
      push(
        {
          kind: "question",
          key: `question:${interactionId}`,
          interactionId,
          itemId: interactionId === asked?.[0] ? replaced : undefined,
          anchorId: id,
        },
        false,
      );
  }
  if (turnId !== undefined) close(undefined);
  const newest = ordered.at(-1);

  // Each turn whose whole tree has settled: its changed files after its last answer, then how
  // it ended after its last block. One pass places them after those blocks.
  const after = new Map<number, Block[]>();
  // Error notices a failed ending shows instead (QA-10).
  const absorbed = new Set<number>();
  const place = (index: number, block: Block) => {
    const list = after.get(index);
    if (list) list.push(block);
    else after.set(index, [block]);
  };
  for (const turn of ordered) {
    if (turn.lastBlock < 0) continue;
    const pseudo = turn.id === "" || turn.id.startsWith("ask:");
    const facts = pseudo ? undefined : source.run?.(turn.id);
    const held = !pseudo && (source.heldTurn === turn.id || source.pausedTurns?.has(turn.id));
    if (held) turn.paused = true;
    if (
      (pseudo && newest === turn && source.unsettledTail) ||
      (!pseudo && !settled(source, turn, newest === turn))
    ) {
      for (const block of turn.work) block.ongoing = true;
      // A pause shows while the turn waits on the limit, before anything settles.
      if (source.heldTurn === turn.id)
        place(turn.lastBlock, endBlock(turn, "paused", newest === turn));
      continue;
    }
    if (turn.openWork && facts?.endedAt !== undefined) turn.openWork.until = facts.endedAt;
    if (turn.edits.length)
      place(turn.lastMessage >= 0 ? turn.lastMessage : turn.lastBlock, {
        kind: "files",
        key: `files:${turn.id || turn.askId || "start"}`,
        itemIds: turn.edits,
      });
    const quota = facts?.failedOn === "quota";
    if (turn.paused && !quota) place(turn.lastBlock, endBlock(turn, "paused", newest === turn));
    // A limit resume interrupts the paused turn: the pause already says why it stopped.
    if (facts?.state === "failed") {
      const end = endBlock(turn, "failed", newest === turn);
      if (turn.failure) {
        absorbed.add(turn.failure.index);
        end.errorId = turn.failure.itemId;
      }
      place(turn.lastBlock, end);
    } else if (facts?.state === "interrupted" && !turn.paused)
      place(turn.lastBlock, endBlock(turn, "interrupted", newest === turn));
  }
  const result = after.size
    ? blocks.flatMap((block, index) => [
        ...(absorbed.has(index) ? [] : [block]),
        ...(after.get(index) ?? []),
      ])
    : blocks;
  // A turn that stopped, failed or paused before any of its output (or its run) is known.
  const last = result.at(-1);
  if (source.stoppedTail && last?.kind === "user")
    result.push({
      kind: "end",
      key: `${source.stoppedTail === "paused" ? "pause" : "end"}:${last.itemId}`,
      ending: source.stoppedTail,
      runId: undefined,
      askId: last.itemId,
      latest: true,
    });
  return result;
}

function endBlock(
  turn: TurnMark,
  ending: "failed" | "interrupted" | "paused",
  latest: boolean,
): Extract<Block, { kind: "end" }> {
  return {
    kind: "end",
    key: `${ending === "paused" ? "pause" : "end"}:${turn.id}`,
    ending,
    runId: turn.id,
    askId: turn.askId,
    automatic: turn.automatic,
    latest,
  };
}

/**
 * Whether a turn's whole tree has settled: every run in it has ended and every agent it spawned
 * has finished. What is still open is added to `watch`, so its settling rebuilds the blocks.
 */
function settled(source: BlockSource, turn: TurnMark, newest: boolean): boolean {
  let done = true;
  for (const runId of turn.runs) {
    if (source.run?.(runId)?.state !== "active") continue;
    done = false;
    source.watch?.runs.add(runId);
  }
  // A child's status is about its latest work: it decides only the newest turn (an older
  // turn's children are judged by their runs in it).
  if (newest)
    for (const agentId of turn.agents) {
      if (source.agentSettled?.(agentId) ?? true) continue;
      done = false;
      source.watch?.agents.add(agentId);
    }
  return done && source.run?.(turn.id) !== undefined;
}

/** The items a block shows, for finding its turn and the row a jump lands on. */
export function blockItems(block: Block): readonly string[] {
  if ("itemIds" in block) return block.itemIds;
  if (block.kind === "question") {
    const shown = block.itemId ?? block.anchorId;
    return shown === undefined ? [] : [shown];
  }
  if (block.kind === "end") return [];
  return [block.itemId];
}

/** Two blocks show the same thing: same kind, key and fields. */
export function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const fields = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const field of fields) {
    const x = left[field];
    const y = right[field];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length || x.some((value, index) => value !== y[index])) return false;
    } else if (!Object.is(x, y)) return false;
  }
  return true;
}

/**
 * The daemon admits a queued message into the transcript as `input:<commandId>` when it accepts
 * it (ADR 0065); while it waits in the queue its pill shows it, so its bubble stays out of the
 * feed until it leaves the queue. So does an ending the transcript tied to it while it waited
 * (an agent that failed with the message last in line): that ending is the turn before's, which
 * becomes the newest in view again (QA-10). Returns `blocks` itself when nothing is hidden. Pure.
 */
export function withoutQueued(
  blocks: readonly Block[],
  queued: readonly { id: string }[] | undefined,
): readonly Block[] {
  if (!queued?.length) return blocks;
  const keys = new Set(queued.map((message) => `input:${message.id}`));
  const hidden = (block: Block) =>
    (block.kind === "user" && keys.has(block.itemId)) ||
    (block.kind === "end" &&
      block.runId === undefined &&
      block.askId !== undefined &&
      keys.has(block.askId));
  if (!blocks.some(hidden)) return blocks;
  const shown = blocks.filter((block) => !hidden(block));
  const last = shown.at(-1);
  // Only a hidden ask came after it: the ending closing the view is the newest turn's again.
  if (last?.kind === "end" && !last.latest) shown[shown.length - 1] = { ...last, latest: true };
  return shown;
}

export function blocksEqual(a: readonly Block[], b: readonly Block[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((block, index) => {
    const other = b[index];
    return !!other && sameBlock(block, other);
  });
}
