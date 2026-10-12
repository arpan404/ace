import { CliTree, Interaction, ThreadId, InteractionId } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { waitSelection, waitSelectionOrRefresh } from "./connection.ts";
import { command, key } from "./mutations.ts";
import { prompt, print, result, mutationResult } from "./io.ts";
import { CliFailure, treeOutcome } from "./output.ts";
export async function listThreads(args: Args, client: Client, signal: AbortSignal) {
  validateArgs(args, ["project"], 2);
  if (args.words[1] !== "list") throw new CliFailure("refused", "Usage: ace threads list");
  const lease = client.threads();
  try {
    await client.threadsWindow({ project: option(args, "project") });
    await waitSelection(
      lease.store.select(["threads", "error"], (reader) => ({
        loaded: reader.loaded,
        error: reader.error,
      })),
      (value) => value.loaded || !!value.error,
      signal,
    );
    if (lease.store.error) throw lease.store.error;
    await result(args, {
      threads: lease.store.ids.map((id) => lease.store.thread(id)),
      window: lease.store.window,
    });
  } finally {
    lease.release();
  }
}
export async function waitThread(args: Args, client: Client, id: string, signal: AbortSignal) {
  const lease = client.thread(id);
  const selection = lease.store.select(["thread", "error", "cursor"], (reader) => ({
    thread: reader.thread,
    error: reader.error,
    cursor: reader.cursor,
  }));
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
  const stop =
    args.flags.stream === "jsonl"
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
      if (streamError) throw streamError;
      if (value.error) throw value.error;
      if (!value.thread) throw new CliFailure("uncertain", "Thread state unavailable");
      const response = await client.request(
        { type: "cli.request", operation: { op: "thread.tree", threadId: ThreadId.parse(id) } },
        { signal },
      );
      if (!response.result.ok)
        throw new CliFailure("uncertain", response.result.code ?? "Tree state unavailable");
      const observedTree = CliTree.parse(response.result.data);
      const outcome = args.flags.tree
        ? treeOutcome(observedTree)
        : observedTree[0]
          ? treeOutcome([{ ...observedTree[0], pending: false }])
          : "uncertain";
      if (outcome !== undefined && client.state === "ready") {
        await stream;
        await result(
          args,
          {
            type: "outcome",
            threadId: id,
            status: outcome,
            thread: value.thread,
            tree: observedTree,
            cancelled: observedTree
              .filter((member) => member.cancelled)
              .map((member) => member.threadId),
          },
          outcome,
        );
        return;
      }
      if (args.flags.stream === "jsonl")
        await print(args, { type: "status", threadId: id, status: value.thread.status });
      // Refresh bounded tree facts even when only a descendant's queue changes.
      await waitSelectionOrRefresh(
        selection,
        (next) => !!next.error || next.cursor !== value.cursor,
        signal,
      );
    }
  } finally {
    stop();
    await stream;
    lease.release();
  }
}
function approval(interaction: Interaction, verb: string, selected: string | undefined) {
  if (interaction.state !== "pending")
    throw new CliFailure("refused", "Interaction is already closed");
  if (interaction.request.kind === "plan_review")
    return { kind: "plan_review", decision: verb === "approve" ? "approve" : "reject" };
  if (interaction.request.kind !== "approval")
    throw new CliFailure("refused", "This interaction requires a question or elicitation answer");
  const choice = interaction.request.options.find((candidate) =>
    selected
      ? candidate.id === selected
      : candidate.kind === (verb === "approve" ? "allow_once" : "deny"),
  );
  if (
    !choice ||
    (verb === "approve"
      ? !choice.kind.startsWith("allow_")
      : !["deny", "deny_always", "cancel"].includes(choice.kind))
  )
    throw new CliFailure("refused", "No matching approval option; specify --option");
  return { kind: "approval", optionId: choice.id };
}
export async function threadCommand(args: Args, client: Client, signal: AbortSignal) {
  const verb = args.words[1];
  validateArgs(
    args,
    ["tree", "idempotency-key", "option", "interaction", "stream"],
    3,
    ["send", "steer"].includes(verb ?? "") ? 4 : 3,
  );
  if (
    !["read", "send", "steer", "wait", "approve", "deny", "cancel", "interrupt"].includes(
      verb ?? "",
    )
  )
    throw new CliFailure("refused", "Unknown thread command");
  const id = ThreadId.parse(args.words[2]);
  if (verb === "wait") return waitThread(args, client, id, signal);
  if (verb === "send" || verb === "steer")
    return mutationResult(
      args,
      await command(
        client,
        {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: await prompt(args, 3) }],
          delivery: verb === "steer" ? "steer" : "queue",
        },
        key(args),
        signal,
      ),
    );
  if (verb === "cancel" || verb === "interrupt")
    return mutationResult(
      args,
      await command(
        client,
        { type: "thread.interrupt", threadId: id, cascade: true },
        key(args),
        signal,
      ),
    );
  const lease = client.thread(id);
  try {
    await waitSelection(
      lease.store.select(["thread", "error"], (reader) => ({
        thread: reader.thread,
        error: reader.error,
      })),
      (value) => !!value.thread || !!value.error,
      signal,
    );
    if (lease.store.error) throw lease.store.error;
    if (verb === "read")
      return result(args, {
        thread: lease.store.thread,
        items: lease.store.order.map((itemId) => lease.store.item(itemId)),
        itemsBefore: lease.store.itemsBefore,
        interactions: lease.store
          .interactionIds()
          .map((interactionId) => lease.store.interaction(interactionId)),
      });
    const interactions = lease.store
      .interactionIds()
      .map((interactionId) => lease.store.interaction(interactionId))
      .filter((value) => value?.state === "pending");
    const selected = option(args, "interaction");
    const interaction = selected
      ? interactions.find((value) => value?.id === selected)
      : interactions.length === 1
        ? interactions[0]
        : undefined;
    if (!interaction)
      throw new CliFailure("refused", "Select a pending interaction with --interaction");
    return mutationResult(
      args,
      await command(
        client,
        {
          type: "interaction.resolve",
          interactionId: InteractionId.parse(interaction.id),
          resolution: approval(interaction, verb ?? "", option(args, "option")),
        },
        key(args),
        signal,
      ),
    );
  } finally {
    lease.release();
  }
}
