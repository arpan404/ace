import { CliTaskStatus, CliOperation } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { key } from "./mutations.ts";
import { waitThreads } from "./waits.ts";
import { prompt, result, mutationResult } from "./io.ts";
import { CliFailure } from "./output.ts";
export async function taskCommand(args: Args, client: Client, signal: AbortSignal) {
  const verb = args.words[1];
  validateArgs(
    args,
    ["parent", "provider", "model", "role", "idempotency-key", "stream", "tree", "any", "all"],
    verb === "spawn" ? 2 : 3,
    verb === "wait" ? 18 : 3,
  );
  if (verb === "wait") return waitThreads(args, client, args.words.slice(2), signal, true);
  if (args.flags.any || args.flags.all)
    throw new CliFailure("refused", "--any/--all apply to wait");
  const id = key(args);
  const operation = CliOperation.parse(
    verb === "spawn"
      ? {
          op: "task.spawn",
          parentId: option(args, "parent"),
          request: {
            requestId: id,
            task: await prompt(args, 2),
            role: option(args, "role") ?? "delegate",
            provider: option(args, "provider") ?? "codex",
            model: option(args, "model"),
            wait: false,
          },
        }
      : { op: `task.${verb}`, threadId: args.words[2], key: id },
  );
  const response = await client
    .request({ type: "cli.request", operation }, { signal })
    .catch((error: unknown) => {
      if (verb === "spawn" || verb === "cancel")
        throw new CliFailure(
          "uncertain",
          `Task acknowledgement unavailable; retry with --idempotency-key ${id}`,
        );
      throw error;
    });
  if (!response.result.ok)
    throw new CliFailure(
      response.result.code === "unavailable" ? "uncertain" : "refused",
      response.result.code ?? "Task refused",
    );
  const data = response.result.data;
  if (verb === "status") {
    const view = CliTaskStatus.parse(data);
    return result(
      args,
      data,
      view.state === "unresponsive"
        ? "uncertain"
        : view.state === "waiting_on_human"
          ? "needs-human"
          : ["failed", "cancelled"].includes(view.state)
            ? "failed"
            : "ok",
    );
  }
  return mutationResult(args, { ok: true, idempotencyKey: id, data });
}
