import { visibleHistoryOrder } from "@ace/projection";
import { executionOrder } from "./execution-order.ts";
import type { BackgroundTask, Item, Run } from "@ace/protocol";
import {
  carriesOnStretch,
  isBareErrorCode,
  isThreadStartCall,
  reviewedInteraction,
  toolRefusal,
  type InlineQuestion,
} from "@ace/ui-core";

export { isInlineInteraction } from "@ace/ui-core";

/**
 * The transcript reads like a document: tool work collapses into "Worked for" segments
 * and each narrated launch batch into a subagent card (subagents' own work interleaves with the
 * parent's, so these are per turn, not per run of adjacent items). What the agent says between
 * steps sits inside that log, in order; what it says after its last step is the answer, shown
 * below it. Launch cards separate work segments, and batch narration stays between the cards.
 * Background tasks, questions and notices show where they happened without opening a
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
  | {
      kind: "message";
      key: string;
      itemId: string;
      /** The answer under a completed turn's head, which already shows when the turn ended. */
      headed?: boolean | undefined;
    }
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
      startedAt?: number | undefined;
      outcome?: "completed" | "interrupted" | "failed" | "paused" | undefined;
      /**
       * A completed turn's head: everything it did before its answer, in order (work, what
       * it said between steps, subagents, background commands), folded behind "Worked for".
       */
      folded?: Block[] | undefined;
      /** The completed turn's answer (every message after its last step), below its head. */
      answerIds?: string[] | undefined;
    }
  /** The newest turn's live header, right under the ask that started it, until it settles. */
  | { kind: "live"; key: string; askId: string | undefined }
  /** The end of the newest working turn's flow: "Thinking" while no step is in flight. */
  | { kind: "thinking"; key: string }
  | { kind: "subagents"; key: string; itemIds: string[] }
  | {
      /** Background commands started one after another in a turn: one row, or one group. */
      kind: "background";
      key: string;
      itemId: string;
      taskId: string;
      itemIds: string[];
      taskIds: string[];
    }
  | { kind: "files"; key: string; itemIds: string[] }
  | { kind: "item"; key: string; itemId: string }
  /**
   * A conversation the agent started with ace's `ace_thread_start`: a card that opens it, where
   * it was started and never folded. Its step stays in the work log too.
   */
  | { kind: "started"; key: string; itemId: string }
  /**
   * A question the agent asked the person, where it was asked: pending or answered, never
   * folded into a work log. `itemId` is the tool call it was asked from (its `ask_user` step,
   * which the block replaces), when that call is loaded; `anchorId` the item it sits after.
   */
  | {
      kind: "question";
      key: string;
      interactionId: string;
      requestKind?: string | undefined;
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
      itemIds?: string[] | undefined;
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
  /** What a decided approval's own line says; undefined while open, withdrawn or timed out. */
  approvalRecord?(interactionId: string): string | undefined;
  task?(id: string): BackgroundTask | undefined;
  pending?: boolean | undefined;
  /** Canonical child-thread link for a native spawn, including late agent links. */
  launchThread?(agentId: string): string | undefined;
  /** The turn (the root agent's run) an item belongs to, where known. */
  turnOf?(itemId: string): string | undefined;
  /** A run's state, trigger and end. */
  run?(runId: string): RunFacts | undefined;
  /** Whether a spawned agent has finished its part of the turn. */
  agentSettled?(agentId: string): boolean;
  /** Shared canonical settlement, including descendants without transcript output. */
  turnSettled?: ((runId: string) => boolean) | undefined;
  turnEndedAt?(runId: string): number | undefined;
  turnIdle?(runId: string): number | undefined;
  turnStartedAt?(runId: string): number | undefined;
  turnEnding?: ((runId: string) => (RunFacts & { runId: string }) | undefined) | undefined;
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
  /** Every block it placed, by index. */
  blocks: Set<number>;
  /** Every run of its tree, and the agents it spawned (whose runs may not have started). */
  runs: Set<string>;
  agents: Set<string>;
  tasks: Set<string>;
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
const isLaunch = (item: Item) =>
  item.type === "delegation.started" ||
  (item.type === "tool_call" && item.call.kind === "agent.spawn");

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
    // Look ahead only within the work segment on this side of a launch card.
    if (isLaunch(item)) stretch++;
    stretchAt[index] = stretch;
    const question =
      anchors.has(id) && item.type === "tool_call" && item.call.detail.kind === "ask_user";
    if (!question && joinsWork(item, source)) lastWork.set(stretch, index);
  }
  return { stretchAt, lastWork };
}

/**
 * The transcript's blocks. A work segment ends at a launch card, an answer or the person's
 * next message. Narration following a launch batch stays in its own transcript block:
 * the agent's words between steps join the log in order, and notices, background tasks,
 * questions, injected messages and other events show inline without ending it. A turn's files
 * card and ending wait until its whole tree has settled (ADR 0062).
 */
export function buildBlocks(source: BlockSource): Block[] {
  const blocks: Block[] = [];
  const workAt = new Map<WorkBlock, number>();
  const anchors = anchorQuestions(source);
  const requests = new Map((source.questions ?? []).map((request) => [request.id, request]));
  // An approval with its tool call in view reads as that call's note ("Approved by you for this
  // thread"), never as a row of its own: repeated asks for one call stay one row.
  const onCall = (id: string) => {
    const request = requests.get(id);
    return (
      request?.kind === "approval" &&
      request.toolCallId !== undefined &&
      source.item(request.toolCallId)?.type === "tool_call"
    );
  };
  // The newest approval each call carries, so an answer repeated without a call of its own
  // ("Approved by you for this thread" again) adds no line after it.
  const callApproval = new Map<string, string>();
  for (const request of source.questions ?? [])
    if (request.kind === "approval" && request.toolCallId)
      callApproval.set(request.toolCallId, request.id);
  let lastAnswer: string | undefined;
  const order = visibleHistoryOrder(executionOrder(source), source.item);
  const { stretchAt, lastWork } = lastWorkOf(order, source, anchors);
  const turns = new Map<string, TurnMark>();
  const ordered: TurnMark[] = [];
  let stretch: { work?: { block: WorkBlock; at: number } } = {};
  // Launch batches belong to their launching agent's own run, independent of work-log stretches.
  const batches = new Map<string, { run: string | undefined; itemIds: string[]; at: number }>();
  const launched = new Map<string, { run: string | undefined; itemIds: string[]; at: number }>();
  const branches = new Map<string, { run: string | undefined; itemIds: string[]; at: number }>();
  const groupOf = new Map<string, { itemIds: string[]; at: number }>();
  let turnId: string | undefined;
  let askId: string | undefined;
  let mark: TurnMark | undefined;
  const markOf = (id: string, ask: string | undefined) => {
    let found = turns.get(id);
    if (!found) {
      const previous = ordered.at(-1);
      if (previous && carriesOnStretch(source.run?.(id)?.trigger)) {
        turns.set(id, previous);
        return previous;
      }
      found = {
        id,
        askId: ask,
        edits: [],
        lastMessage: -1,
        lastBlock: -1,
        blocks: new Set(),
        runs: new Set(),
        agents: new Set(),
        tasks: new Set(),
        openWork: undefined,
        work: [],
        paused: false,
        automatic: false,
        failure: undefined,
      };
      // A turn ace started after the previous one stopped (a restart, a limit resume).
      const trigger = source.run?.(id)?.trigger;
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
    mark.blocks.add(index);
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
      const item = source.item(id);
      if (!item) return;
      const owner = item.agentId ?? "";
      const child =
        item.type === "delegation.started"
          ? item.childThreadId
          : item.type === "tool_call" &&
              item.call.detail.kind === "agent.spawn" &&
              item.call.detail.childAgentId
            ? source.launchThread?.(item.call.detail.childAgentId)
            : undefined;
      let open = branches.get(owner) ?? (child ? launched.get(child) : undefined);
      if (!open) {
        const batch = batches.get(owner);
        if (batch?.run === item.runId) open = batch;
      }
      if (!open) {
        close(item.createdAt);
        const itemIds: string[] = [];
        const at = blocks.push({ kind, key: `${kind}:${id}`, itemIds }) - 1;
        open = { run: item.runId, itemIds, at };
      }
      // A delayed duplicate stays at its original launch; it cannot reopen a narrated batch.
      if (!child || !launched.has(child)) batches.set(owner, open);
      if (child) launched.set(child, open);
      if (
        item.type === "tool_call" &&
        item.call.detail.kind === "agent.spawn" &&
        item.call.detail.childAgentId
      )
        branches.set(item.call.detail.childAgentId, open);
      open.itemIds.push(id);
      placed(open.at);
      return;
    }
    let open = stretch.work;
    if (!open) {
      const block: WorkBlock = { kind, key: `${kind}:${id}`, itemIds: [] };
      open = stretch.work = { block, at: blocks.push(block) - 1 };
      workAt.set(block, open.at);
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
  const askAt = new Map<string, number>();
  for (const [index, id] of order.entries()) {
    const item = source.item(id);
    if (!item) continue;
    const person = isPerson(item);
    if (person) lastAnswer = undefined;
    const carried = callApproval.get(id);
    if (carried !== undefined) lastAnswer = source.approvalRecord?.(carried) ?? lastAnswer;
    const launchNarration =
      item.type === "message" &&
      item.role === "assistant" &&
      !item.synthetic &&
      batches.has(item.agentId ?? "");
    if (person) batches.clear();
    else if (item.type === "message" && !item.synthetic) batches.delete(item.agentId ?? "");
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
    const asked = anchors.get(id)?.filter((interactionId) => !onCall(interactionId));
    // A question's own step: the question block stands in for it.
    const replaced =
      !!asked?.length && item.type === "tool_call" && item.call.detail.kind === "ask_user"
        ? id
        : undefined;
    if (!replaced)
      switch (item.type) {
        case "message":
          if (item.synthetic) push({ kind: "event", key: id, itemId: id }, false);
          else if (person) {
            push({ kind: "user", key: id, itemId: id }, item.createdAt);
            askAt.set(id, blocks.length - 1);
          } else {
            // Said between steps: it reads inside the log, in order. After the last step: the
            // answer, below the log.
            const between =
              !launchNarration && (lastWork.get(stretchAt[index] ?? -1) ?? -1) > index;
            if (between) group("work", id);
            else
              push(
                { kind: "message", key: id, itemId: id },
                launchNarration || item.complete ? item.createdAt : false,
                true,
              );
            // The agent spoke after the error: that error was not how the turn ended.
            if (mark) mark.failure = undefined;
          }
          break;
        case "tool_call": {
          const taskId = source.background.get(id);
          if (item.call.kind === "agent.spawn") {
            group("subagents", id);
            if (item.call.detail.kind === "agent.spawn" && item.call.detail.childAgentId)
              mark?.agents.add(item.call.detail.childAgentId);
          } else if (isThreadStartCall(item)) {
            // Even when a provider tracked the call as a background task: it starts a thread,
            // it is not a command left running.
            group("work", id);
            push({ kind: "started", key: `started:${id}`, itemId: id }, false);
          } else if (taskId !== undefined) {
            mark?.tasks.add(taskId);
            const last = blocks.at(-1);
            // Background commands started back to back in the same turn read as one group.
            if (last?.kind === "background" && mark?.blocks.has(blocks.length - 1)) {
              last.itemIds.push(id);
              last.taskIds.push(taskId);
            } else
              push(
                {
                  kind: "background",
                  key: id,
                  itemId: id,
                  taskId,
                  itemIds: [id],
                  taskIds: [taskId],
                },
                false,
              );
          } else {
            group("work", id);
            if (editKinds.has(item.call.kind)) mark?.edits.push(id);
          }
          break;
        }
        case "reasoning":
          group("work", id);
          break;
        case "delegation.started":
          group("subagents", id);
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
            // A refused agent tool is the agent's to handle, not why its turn failed.
            if (mark && item.level === "error" && !isBareErrorCode(item.text) && !toolRefusal(item))
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
    for (const interactionId of asked ?? []) {
      const kind = requests.get(interactionId)?.kind;
      if (kind === "approval" && source.approvalRecord) {
        // An approval with no call row: a line only when its answer differs from the turn's
        // last one, and none for one withdrawn or timed out before the person answered.
        const label = source.approvalRecord(interactionId);
        if (label === undefined || label === lastAnswer) continue;
        lastAnswer = label;
      }
      push(
        {
          kind: "question",
          key: `question:${interactionId}`,
          interactionId,
          requestKind: kind,
          itemId: interactionId === asked?.[0] ? replaced : undefined,
          anchorId: id,
        },
        false,
      );
    }
  }
  if (turnId !== undefined) close(undefined);
  const newest = ordered.at(-1);
  const newestRun = ordered.findLast((turn) => source.run?.(turn.id) !== undefined);

  // Each turn whose whole tree has settled: its changed files after its last answer, then how
  // it ended after its last block. One pass places them after those blocks.
  const after = new Map<number, Block[]>();
  const before = new Map<number, Block[]>();
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
    const startedAt = source.turnStartedAt?.(turn.id) ?? facts?.startedAt;
    const ending =
      source.turnEnding?.(turn.id) ?? (facts ? { ...facts, runId: turn.id } : undefined);
    const held = !pseudo && (source.heldTurn === turn.id || source.pausedTurns?.has(turn.id));
    if (held) turn.paused = true;
    if (
      (pseudo && newest === turn && source.unsettledTail) ||
      (!pseudo && !settled(source, turn, newestRun === turn))
    ) {
      for (const block of turn.work) block.ongoing = true;
      // The newest turn says what it is doing right under the ask that started it.
      if (newest === turn && source.heldTurn !== turn.id) {
        const live: Block = { kind: "live", key: `live:${turn.id}`, askId: turn.askId };
        const ask = turn.askId === undefined ? undefined : askAt.get(turn.askId);
        const first = Math.min(...turn.blocks);
        if (ask !== undefined) place(ask, live);
        else if (Number.isFinite(first)) before.set(first, [live, ...(before.get(first) ?? [])]);
        place(turn.lastBlock, { kind: "thinking", key: `thinking:${turn.id}` });
      }
      // A pause shows while the turn waits on the limit, before anything settles.
      if (source.heldTurn === turn.id) {
        place(turn.lastBlock, endBlock(turn, "paused", newest === turn, ending?.runId));
        for (const block of turn.work) absorbed.add(workAt.get(block) ?? -1);
      }
      continue;
    }
    if (turn.openWork && facts?.endedAt !== undefined) turn.openWork.until = facts.endedAt;
    if (facts?.endedAt !== undefined && startedAt !== undefined && !turn.paused) {
      const ends = [...turn.runs].flatMap((id) => source.run?.(id)?.endedAt ?? []);
      const taskEnds = [...turn.tasks].flatMap((id) => source.task?.(id)?.endedAt ?? []);
      const until = Math.max(
        facts.endedAt,
        source.turnEndedAt?.(turn.id) ?? facts.endedAt,
        ...ends,
        ...taskEnds,
      );
      const first = turn.work[0];
      const firstIds = first?.itemIds ?? [];
      const state = ending?.state ?? facts.state;
      const outcome = turn.paused ? "paused" : state === "active" ? "completed" : state;
      let head: WorkBlock | undefined = first;
      if (first) {
        first.startedAt = startedAt;
        first.idle =
          source.turnIdle?.(turn.id) ??
          turn.work.reduce((total, work) => total + (work.idle ?? 0), 0);
        first.until = until;
        first.outcome = outcome;
        first.itemIds = turn.work.flatMap((block) => block.itemIds);
        for (const block of turn.work.slice(1)) absorbed.add(workAt.get(block) ?? -1);
      } else {
        const at = turn.lastMessage >= 0 ? turn.lastMessage : turn.lastBlock + 1;
        const summary: WorkBlock = {
          kind: "work",
          key: `work:turn:${turn.id}`,
          itemIds: [],
          startedAt,
          idle: source.turnIdle?.(turn.id),
          until,
          outcome,
        };
        if (at < blocks.length) before.set(at, [...(before.get(at) ?? []), summary]);
        else place(turn.lastBlock, summary);
        head = summary;
      }
      // A completed turn folds into "Worked for": only its answer, failures and changed
      // files stay in view. Failed and stopped turns keep everything they did in view.
      if (outcome === "completed" && head) {
        const folded: Block[] = [];
        const headAt = first ? workAt.get(first) : undefined;
        // Everything the agent said after its last step is the answer: it all stays in view.
        const finalStep = Math.max(-1, ...turn.work.map((work) => workAt.get(work) ?? -1));
        const answers: string[] = [];
        for (const index of [...turn.blocks].toSorted((a, b) => a - b)) {
          const block = blocks[index];
          if (!block) continue;
          if (block.kind === "message" && (index > finalStep || index === turn.lastMessage)) {
            answers.push(block.itemId);
            blocks[index] = { ...block, headed: true };
            continue;
          }
          if (index === headAt) folded.push({ kind: "work", key: head.key, itemIds: firstIds });
          else if (foldable(block)) {
            folded.push(block);
            absorbed.add(index);
          }
        }
        if (folded.length) head.folded = folded;
        if (answers.length) head.answerIds = answers;
      }
    }
    if (turn.edits.length)
      place(turn.lastMessage >= 0 ? turn.lastMessage : turn.lastBlock, {
        kind: "files",
        key: `files:${turn.id || turn.askId || "start"}`,
        itemIds: turn.edits,
      });
    const quota = ending?.failedOn === "quota";
    if (turn.paused && !quota) {
      place(turn.lastBlock, endBlock(turn, "paused", newest === turn, ending?.runId));
      for (const block of turn.work) absorbed.add(workAt.get(block) ?? -1);
    }
    // A limit resume interrupts the paused turn: the pause already says why it stopped.
    if (ending?.state === "failed") {
      const end = endBlock(turn, "failed", newest === turn, ending.runId);
      if (turn.failure) {
        absorbed.add(turn.failure.index);
        end.errorId = turn.failure.itemId;
      }
      place(turn.lastBlock, end);
    } else if (
      ending?.state === "interrupted" &&
      !turn.paused &&
      (ending.endedAt === undefined || startedAt === undefined)
    )
      place(turn.lastBlock, endBlock(turn, "interrupted", newest === turn, ending.runId));
  }
  const result =
    after.size || before.size || absorbed.size
      ? blocks.flatMap((block, index) => [
          ...(before.get(index) ?? []),
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

/**
 * Whether a settled turn's block folds behind its "Worked for": its steps, what it said between
 * them and its background commands. Never a notice, an ending, a request it asked (with its
 * answer), a record such as a saved file, or the subagents it started: those stay where they
 * happened, since the steps read back on opening are the turn's work alone.
 */
function foldable(block: Block): boolean {
  return block.kind === "work" || block.kind === "message" || block.kind === "background";
}

function endBlock(
  turn: TurnMark,
  ending: "failed" | "interrupted" | "paused",
  latest: boolean,
  runId = turn.id,
): Extract<Block, { kind: "end" }> {
  return {
    kind: "end",
    key: `${ending === "paused" ? "pause" : "end"}:${turn.id}`,
    ending,
    runId,
    askId: turn.askId,
    automatic: turn.automatic,
    latest,
    itemIds: turn.work.flatMap((block) => block.itemIds),
  };
}

/**
 * Whether a turn's whole tree has settled: every run in it has ended and every agent it spawned
 * has finished. What is still open is added to `watch`, so its settling rebuilds the blocks.
 */
function settled(source: BlockSource, turn: TurnMark, newest: boolean): boolean {
  if (source.turnSettled) return source.turnSettled(turn.id);
  let done = !(newest && (source.pending || (source.unsettledTail && !source.heldTurn)));
  for (const taskId of turn.tasks) {
    const task = source.task?.(taskId);
    if (task?.status === "running" || task?.status === "unknown") done = false;
  }
  for (const runId of turn.runs) {
    if (source.run?.(runId)?.state !== "active") continue;
    done = false;
    source.watch?.runs.add(runId);
  }
  // Compatibility for callers without the canonical tree projection.
  for (const agentId of turn.agents) {
    if (source.agentSettled?.(agentId) ?? true) continue;
    done = false;
    source.watch?.agents.add(agentId);
  }
  return done && source.run?.(turn.id) !== undefined;
}

/** The items a block shows, for finding its turn and the row a jump lands on. */
export function blockItems(block: Block): readonly string[] {
  // A folded head holds its turn in order: each item once, as the turn said it.
  if (block.kind === "work" && block.folded)
    return [...new Set([...block.folded.flatMap((inner) => blockItems(inner)), ...block.itemIds])];
  if ("itemIds" in block) return block.itemIds ?? [];
  // A started thread's card repeats a step its work log already holds.
  if (block.kind === "live" || block.kind === "thinking" || block.kind === "started") return [];
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
      if (x.length !== y.length || x.some((value, index) => !sameEntry(value, y[index])))
        return false;
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

/** Array entries match: the same value, or folded blocks that show the same thing. */
function sameEntry(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return isBlock(a) && isBlock(b) && sameBlock(a, b);
}
function isBlock(value: unknown): value is Block {
  return typeof value === "object" && value !== null && "kind" in value && "key" in value;
}

export function blocksEqual(a: readonly Block[], b: readonly Block[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((block, index) => {
    const other = b[index];
    return !!other && sameBlock(block, other);
  });
}
