import type { ThreadReader } from "@ace/client";
import type { Agent, Run } from "@ace/protocol";
import { ledgerOf, limitHoldShown, rootRunOf, type TurnReader } from "@ace/ui-core";
import type { Watched } from "@/lib/use-watched.ts";
import { buildBlocks, blocksEqual, sameBlock, type Block, type RunFacts } from "./blocks.ts";

const none: readonly Block[] = [];
const noKeys: readonly string[] = [];

/** Full identities include late ancestry links on settled entities, not only active status. */
function watchedEntity(reader: ThreadReader, key: string): unknown {
  if (key.startsWith("run:")) return reader.run(key.slice(4));
  if (key.startsWith("item:")) return reader.item(key.slice(5));
  return reader.agent(key.slice(6));
}

/** The run's failure kind, once the daemon reports it on the run (C-A adds `Run.error`). */
function failedOn(run: Run): string | undefined {
  const error: unknown = "error" in run ? run.error : undefined;
  return typeof error === "object" && error !== null && "kind" in error
    ? String(error.kind)
    : undefined;
}

/** A spawned agent has finished its part: it isn't starting, working or blocked on work. */
function agentSettled(agent: Agent | undefined): boolean {
  const status = agent?.status;
  if (!status) return true;
  if (status.state === "starting" || status.state === "working") return false;
  return status.state !== "blocked" || status.on === "background_task";
}

/** The newest loaded turn of the root agent (walks back to the first item with a run). */
function newestTurn(reader: ThreadReader): string | undefined {
  for (let index = reader.order.length - 1; index >= 0; index--) {
    const run = rootRunOf(reader, reader.item(reader.order[index] ?? "")?.runId);
    if (run) return run.id;
  }
  return undefined;
}

/**
 * A selector that remembers its last result and what it was built from: it rebuilds only when
 * an input changed (the order, inline questions, background calls, the owner's status, or a
 * watched ancestry entity), and keeps each unchanged block's object, so memoized rows skip
 * re-rendering. `agentId` builds one agent's own blocks.
 */
export function createBlockReader(
  agentId?: string,
): (reader: ThreadReader) => Watched<readonly Block[]> {
  let last: readonly Block[] = none;
  let lastWatch: readonly string[] = noKeys;
  let inputs: readonly unknown[] = [];
  let ownOrder: { from: readonly string[]; order: readonly string[] } | undefined;
  // Turns seen held by a usage limit while this transcript was open.
  const paused = new Set<string>();
  return (reader) => {
    const ledger = ledgerOf(reader);
    const ownerId = agentId ?? reader.thread?.rootAgentId;
    const owner = ownerId ? reader.agent(ownerId) : undefined;
    const status = owner?.status;
    const state = reader.thread?.status.state;
    const unsettledTail =
      agentId === undefined
        ? state !== undefined && state !== "done" && state !== "failed" && state !== "new"
        : !agentSettled(owner);
    const limited =
      agentId === undefined &&
      status?.state === "blocked" &&
      status.on === "rate_limit" &&
      limitHoldShown(reader.thread?.status, reader.queue);
    const heldTurn = limited ? newestTurn(reader) : undefined;
    if (heldTurn) paused.add(heldTurn);
    if (agentId !== undefined && ownOrder?.from !== reader.order)
      ownOrder = {
        from: reader.order,
        order: reader.order.filter((id) => reader.item(id)?.agentId === agentId),
      };
    const order = agentId === undefined ? reader.order : (ownOrder?.order ?? noKeys);
    const fixed = [
      order,
      ownerId,
      ledger.interactionsVersion,
      ledger.tasksVersion,
      status,
      unsettledTail,
      limited,
      heldTurn,
    ];
    const next = [...fixed, ...lastWatch.map((key) => watchedEntity(reader, key))];
    if (next.length === inputs.length && next.every((input, index) => input === inputs[index]))
      return { value: last, watch: lastWatch };
    const watch = { runs: new Set<string>(), agents: new Set<string>() };
    const spawnItems = new Set<string>();
    // rootRunOf follows only the entities in a run's ancestry. Observe those links even after
    // the tree settles, including missing entities that may arrive later. Ordinary output
    // items are deliberately read through `reader`, so streaming text never regroups blocks.
    const ancestry: TurnReader = {
      order: reader.order,
      thread: reader.thread,
      run: (id) => {
        watch.runs.add(id);
        return reader.run(id);
      },
      agent: (id) => {
        watch.agents.add(id);
        return reader.agent(id);
      },
      item: (id) => {
        spawnItems.add(id);
        return reader.item(id);
      },
    };
    const built = buildBlocks({
      order,
      item: (id) => reader.item(id),
      background: ledger.background,
      questions: agentId === undefined ? ledger.questions() : [],
      // Turns are the root agent's runs (a subagent's work counts toward the turn that spawned
      // it); one agent's own transcript turns on its own runs.
      turnOf: (id) => {
        const runId = reader.item(id)?.runId;
        return agentId === undefined ? rootRunOf(ancestry, runId)?.id : runId;
      },
      run: (runId): RunFacts | undefined => {
        const run = ancestry.run(runId);
        return (
          run && {
            state: run.state,
            trigger: run.trigger,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            failedOn: failedOn(run),
          }
        );
      },
      agentSettled: (id) => agentSettled(reader.agent(id)),
      reviewedCall: (interactionId) => reader.interaction(interactionId)?.toolCallId,
      heldTurn,
      pausedTurns: paused,
      stoppedTail:
        status?.state === "failed" || status?.state === "interrupted"
          ? status.state
          : limited
            ? "paused"
            : undefined,
      watch,
      unsettledTail,
    });
    const byKey = new Map(last.map((block) => [block.key, block]));
    const blocks = built.map((block) => {
      const old = byKey.get(block.key);
      return old && sameBlock(old, block) ? old : block;
    });
    const keys = [
      ...[...watch.runs].map((id) => `run:${id}`),
      ...[...watch.agents].map((id) => `agent:${id}`),
      ...[...spawnItems].map((id) => `item:${id}`),
    ];
    last = blocksEqual(last, blocks) ? last : blocks;
    lastWatch =
      keys.length === lastWatch.length && keys.every((key, i) => key === lastWatch[i])
        ? lastWatch
        : keys;
    inputs = [...fixed, ...lastWatch.map((key) => watchedEntity(reader, key))];
    return { value: last, watch: lastWatch };
  };
}
