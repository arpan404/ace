import { CommandPayload, CommandId, ProviderKind, WorkspaceId, ThreadId } from "@ace/protocol";
import { createHash, randomUUID } from "node:crypto";
import { resolve, basename } from "node:path";
import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { prompt, mutationResult } from "./io.ts";
import { CliFailure } from "./output.ts";
export function key(args: Args): string {
  const value = option(args, "idempotency-key") ?? randomUUID();
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(value))
    throw new CliFailure(
      "refused",
      "Idempotency key must be 1-128 letters, digits, dots, underscores or hyphens",
    );
  return value;
}
export async function command(client: Client, payload: unknown, id: string, signal: AbortSignal) {
  try {
    const receipt = await client.command(
      CommandPayload.parse(payload),
      { signal },
      CommandId.parse(id),
    );
    if (!receipt.ok)
      throw new CliFailure(
        receipt.error?.includes("uncertain") ? "uncertain" : "refused",
        receipt.error ?? receipt.code ?? "Command refused",
      );
    return { ...receipt, idempotencyKey: id };
  } catch (error) {
    if (signal.aborted)
      throw new CliFailure(
        "uncertain",
        `Command acknowledgement unavailable; retry with --idempotency-key ${id}`,
      );
    throw error;
  }
}
export async function runCommand(args: Args, client: Client, signal: AbortSignal) {
  validateArgs(
    args,
    ["provider", "project", "worktree", "model", "idempotency-key", "stream"],
    1,
    2,
  );
  if (args.flags.stream && args.flags.stream !== "jsonl")
    throw new CliFailure("refused", "--stream supports jsonl");
  const text = await prompt(args, 1);
  const id = key(args);
  const project = option(args, "project");
  let workspaceId: string;
  if (project && !project.includes("/") && !project.startsWith("."))
    workspaceId = WorkspaceId.parse(project);
  else {
    const path = resolve(project ?? process.cwd());
    const receipt = await command(
      client,
      { type: "workspace.add", path, name: basename(path) },
      `project-${createHash("sha256").update(path).digest("hex")}`,
      signal,
    );
    if (!receipt.workspace)
      throw new CliFailure("uncertain", "Workspace registration returned no identity");
    workspaceId = receipt.workspace.id;
  }
  // Caller-owned thread identity makes a retried run stable, even before admission completes.
  const threadId = ThreadId.parse(`cli-${createHash("sha256").update(id).digest("hex")}`);
  const receipt = await command(
    client,
    {
      type: "thread.create",
      workspaceId,
      threadId,
      provider: ProviderKind.parse(option(args, "provider") ?? "codex"),
      model: option(args, "model"),
      mode: args.flags.worktree ? "worktree" : "local",
      input: [{ type: "text", text }],
    },
    id,
    signal,
  );
  await mutationResult(args, {
    type: "admission",
    ok: true,
    status: "accepted",
    commandId: id,
    idempotencyKey: id,
    threadId: receipt.threadId ?? threadId,
  });
  return receipt.threadId ?? threadId;
}
