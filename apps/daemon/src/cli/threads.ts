import { ThreadId, InteractionId } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { waitSelection } from "./connection.ts";
import { waitThreads } from "./waits.ts";
export { waitThread } from "./waits.ts";
import { command, key } from "./mutations.ts";
import { approval } from "./approval.ts";
import { prompt, result, mutationResult } from "./io.ts";
import { CliFailure } from "./output.ts";
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
export async function threadCommand(args: Args, client: Client, signal: AbortSignal) {
  const verb = args.words[1];
  validateArgs(
    args,
    ["tree", "idempotency-key", "option", "interaction", "stream", "any", "all"],
    3,
    verb === "wait" ? 18 : ["send", "steer"].includes(verb ?? "") ? 4 : 3,
  );
  if (
    !["read", "send", "steer", "wait", "approve", "deny", "cancel", "interrupt"].includes(
      verb ?? "",
    )
  )
    throw new CliFailure("refused", "Unknown thread command");
  if (verb === "wait")
    return waitThreads(args, client, args.words.slice(2), signal, !!args.flags.tree);
  if (args.flags.any || args.flags.all)
    throw new CliFailure("refused", "--any/--all apply to wait");
  const id = ThreadId.parse(args.words[2]);
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
