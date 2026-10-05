import type { ThreadKey, ThreadReader } from "@ace/client";
import { useThreadMeta } from "@ace/client-react";
import type { Agent, Run } from "@ace/protocol";
import { ledgerOf, limitHoldShown, rootRunOf } from "@ace/ui-core";
import { useMemo, useState } from "react";
import { buildBlocks, blocksEqual, sameBlock, type Block, type RunFacts } from "./blocks.ts";
import { useWatched, type Watched } from "./use-watched.ts";

const none: readonly Block[] = [];
const noKeys: readonly string[] = [];

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
 * watched run or agent), and keeps each unchanged block's object, so memoized rows skip
 * re-rendering. `agentId` builds one agent's own blocks.
 */
function createBlockReader(agentId?: string): (reader: ThreadReader) => Watched<readonly Block[]> {
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
    const next = [
      order,
      ledger.questions().length,
      ledger.tasksVersion,
      status,
      limited,
      heldTurn,
      ...lastWatch.map((key) =>
        key.startsWith("run:") ? reader.run(key.slice(4)) : reader.agent(key.slice(6)),
      ),
    ];
    if (next.length === inputs.length && next.every((input, index) => input === inputs[index]))
      return { value: last, watch: lastWatch };
    const watch = { runs: new Set<string>(), agents: new Set<string>() };
    const built = buildBlocks({
      order,
      item: (id) => reader.item(id),
      background: ledger.background,
      questions: agentId === undefined ? ledger.questions() : [],
      // Turns are the root agent's runs (a subagent's work counts toward the turn that spawned
      // it); one agent's own transcript turns on its own runs.
      turnOf: (id) => {
        const runId = reader.item(id)?.runId;
        return agentId === undefined ? rootRunOf(reader, runId)?.id : runId;
      },
      run: (runId): RunFacts | undefined => {
        const run = reader.run(runId);
        return (
          run && {
            state: run.state,
            trigger: run.trigger,
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
    });
    const byKey = new Map(last.map((block) => [block.key, block]));
    const blocks = built.map((block) => {
      const old = byKey.get(block.key);
      return old && sameBlock(old, block) ? old : block;
    });
    const keys = [
      ...[...watch.runs].map((id) => `run:${id}`),
      ...[...watch.agents].map((id) => `agent:${id}`),
    ];
    last = blocksEqual(last, blocks) ? last : blocks;
    lastWatch =
      keys.length === lastWatch.length && keys.every((key, i) => key === lastWatch[i])
        ? lastWatch
        : keys;
    inputs = [
      ...next.slice(0, 6),
      ...lastWatch.map((key) =>
        key.startsWith("run:") ? reader.run(key.slice(4)) : reader.agent(key.slice(6)),
      ),
    ];
    return { value: last, watch: lastWatch };
  };
}

/** What blocks are built from: items, background tasks, interactions and how turns end. */
function useBlockKeys(threadId: string, agentId?: string): readonly ThreadKey[] {
  const owner = useThreadMeta(threadId)?.rootAgentId;
  const agent = agentId ?? owner ?? "";
  return useMemo(
    () => ["order", "tasks", "interactions", "agents", "thread", "queue", `agent:${agent}`],
    [agent],
  );
}

/**
 * Transcript blocks. Re-derived only when items are added, background tasks start, inline
 * questions open, or a turn's runs and spawned agents settle (each watched by its own key),
 * never on a streamed delta; the list and each unchanged block keep their identity. The thread
 * screen remounts per thread, so one reader serves one thread.
 */
export function useBlocks(threadId: string): readonly Block[] {
  const [read] = useState(() => createBlockReader());
  return useWatched(threadId, useBlockKeys(threadId), read, blocksEqual) ?? none;
}

/** One agent's own blocks in the loaded window (a subagent's work, without its parent's). */
export function useAgentBlocks(threadId: string, agentId: string): readonly Block[] {
  const [read] = useState(() => createBlockReader(agentId));
  return useWatched(threadId, useBlockKeys(threadId, agentId), read, blocksEqual) ?? none;
}
