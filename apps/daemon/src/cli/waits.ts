import { CliTree, ThreadId, type Thread } from "@ace/protocol";
import type { Client } from "@ace/client";
import type { Args } from "./args.ts";
import { waitSelection, waitSelectionOrRefresh } from "./connection.ts";
import { print, result } from "./io.ts";
import { CliFailure, treeOutcome, type Outcome } from "./output.ts";

type WorkOutcome = NonNullable<ReturnType<typeof treeOutcome>>;
interface Observed {
  threadId: string;
  status: WorkOutcome;
  thread: Thread;
  tree: CliTree;
}
/** Resolves once one thread (or its whole tree) reaches an outcome, refreshing on each change. */
async function observe(
  client: Client,
  id: string,
  tree: boolean,
  signal: AbortSignal,
  onStatus?: (thread: Thread) => Promise<void>,
): Promise<Observed> {
  const lease = client.thread(id);
  const selection = lease.store.select(["thread", "error", "cursor"], (reader) => ({
    thread: reader.thread,
    error: reader.error,
    cursor: reader.cursor,
  }));
  try {
    while (true) {
      if (client.state !== "ready")
        await waitSelection(
          client.connectionState(),
          (state) => state === "ready" || state === "fatal",
          signal,
        );
      if (client.state === "fatal") throw client.error;
      const value = await waitSelection(
        selection,
        (candidate) => !!candidate.error || !!candidate.thread,
        signal,
      );
      if (value.error) throw value.error;
      if (!value.thread) throw new CliFailure("uncertain", "Thread state unavailable");
      const response = await client.request(
        { type: "cli.request", operation: { op: "thread.tree", threadId: ThreadId.parse(id) } },
        { signal },
      );
      if (!response.result.ok)
        throw new CliFailure("uncertain", response.result.code ?? "Tree state unavailable");
      const observedTree = CliTree.parse(response.result.data);
      const outcome = tree
        ? treeOutcome(observedTree)
        : observedTree[0]
          ? treeOutcome([{ ...observedTree[0], pending: false }])
          : "uncertain";
      if (outcome !== undefined && client.state === "ready")
        return { threadId: id, status: outcome, thread: value.thread, tree: observedTree };
      await onStatus?.(value.thread);
      // Refresh bounded tree facts even when only a descendant's queue changes.
      await waitSelectionOrRefresh(
        selection,
        (next) => !!next.error || next.cursor !== value.cursor,
        signal,
      );
    }
  } finally {
    lease.release();
  }
}
function outcomeBody(observed: Observed) {
  return {
    threadId: observed.threadId,
    status: observed.status,
    thread: observed.thread,
    tree: observed.tree,
    cancelled: observed.tree.filter((member) => member.cancelled).map((member) => member.threadId),
  };
}
/** One thread, optionally streaming JSONL snapshots and events until it settles. */
export async function waitThread(args: Args, client: Client, id: string, signal: AbortSignal) {
  let stream = Promise.resolve();
  let queuedBytes = 0;
  let streamError: unknown;
  const emit = (value: unknown) => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    queuedBytes += bytes;
    if (queuedBytes > 1_048_576) {
      streamError = new CliFailure("uncertain", "Stream consumer is too slow");
      return;
    }
    stream = stream
      .then(() => print(args, value))
      .catch((error: unknown) => {
        streamError = error;
      })
      .finally(() => {
        queuedBytes -= bytes;
      });
  };
  const streaming = args.flags.stream === "jsonl";
  const stop = streaming
    ? client.onMessage((message) => {
        if (
          message.type === "snapshot" &&
          message.view.kind === "thread" &&
          message.view.thread.id === id
        )
          emit({ type: "snapshot", view: message.view });
        if (message.type === "events")
          for (const event of message.events)
            if (event.threadId === id) emit({ type: "event", event });
      })
    : () => {};
  try {
    const observed = await observe(client, id, !!args.flags.tree, signal, async (thread) => {
      if (streamError) throw streamError;
      if (streaming) await print(args, { type: "status", threadId: id, status: thread.status });
    });
    await stream;
    if (streamError) throw streamError;
    await result(args, { type: "outcome", ...outcomeBody(observed) }, observed.status);
  } finally {
    stop();
    await stream;
  }
}
/** Several threads: `all` reports once each settles, `any` on the first; needs-human wins early. */
export function combinedOutcome(
  mode: "any" | "all",
  settled: readonly WorkOutcome[],
  total: number,
): Outcome | undefined {
  if (settled.includes("needs-human")) return "needs-human";
  if (mode === "any") return settled[0];
  if (settled.length < total) return undefined;
  for (const outcome of ["uncertain", "failed"] as const)
    if (settled.includes(outcome)) return outcome;
  return "ok";
}
export async function waitThreads(
  args: Args,
  client: Client,
  ids: readonly string[],
  signal: AbortSignal,
  tree: boolean,
) {
  if (args.flags.any && args.flags.all) throw new CliFailure("refused", "Use --any or --all");
  const unique = [...new Set(ids.map((id) => ThreadId.parse(id)))];
  if (unique.length === 1 && !args.flags.any && !args.flags.all)
    return waitThread(
      { ...args, flags: { ...args.flags, ...(tree ? { tree: true } : {}) } },
      client,
      unique[0]!,
      signal,
    );
  if (args.flags.stream) throw new CliFailure("refused", "--stream follows one thread");
  if (unique.length > 16) throw new CliFailure("refused", "Wait for at most 16 threads");
  const mode = args.flags.any ? "any" : "all";
  const observation = new AbortController();
  const scoped = AbortSignal.any([signal, observation.signal]);
  const settled: Observed[] = [];
  let status: Outcome | undefined;
  try {
    status = await new Promise<Outcome>((resolve, reject) => {
      for (const id of unique)
        observe(client, id, tree, scoped).then((observed) => {
          settled.push(observed);
          const combined = combinedOutcome(
            mode,
            settled.map((each) => each.status),
            unique.length,
          );
          if (combined) resolve(combined);
        }, reject);
    });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    observation.abort();
  }
  const finished = new Set(settled.map((each) => each.threadId));
  await result(
    args,
    {
      type: "outcome",
      mode,
      status,
      threads: settled.map(outcomeBody),
      pending: unique.filter((id) => !finished.has(id)),
    },
    status,
  );
}
