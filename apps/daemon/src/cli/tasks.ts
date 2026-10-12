import { AgentTaskView, CliOperation, ThreadId } from "@ace/protocol";
import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { key } from "./work.ts";
import { waitThread } from "./threads.ts";
import { prompt, result } from "./io.ts";
import { CliFailure } from "./output.ts";
export async function taskCommand(args: Args, client: Client, signal: AbortSignal) {
  const verb = args.words[1];
  validateArgs(
    args,
    ["parent", "provider", "model", "role", "idempotency-key", "stream", "tree"],
    verb === "spawn" ? 2 : 3,
    3,
  );
  if (verb === "wait")
    return waitThread(
      { ...args, flags: { ...args.flags, tree: true } },
      client,
      ThreadId.parse(args.words[2]),
      signal,
    );
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
    const view = AgentTaskView.parse(data);
    return result(
      args,
      data,
      view.state === "waiting_on_human" ? "needs-human" : view.state === "failed" ? "failed" : "ok",
    );
  }
  return result(args, { ok: true, idempotencyKey: id, data });
}
