import { ProviderKind, WorkspaceId, ThreadId } from "@ace/protocol";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Client } from "@ace/client";
import { option, validateArgs, type Args } from "./args.ts";
import { prompt, mutationResult } from "./io.ts";
import { CliFailure } from "./output.ts";
import { command, key } from "./mutations.ts";
import { addProject } from "./projects.ts";
export async function runCommand(
  args: Args,
  client: Client,
  signal: AbortSignal,
  project = option(args, "project"),
) {
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
  const admission = await admitWork(
    {
      text,
      id,
      project,
      provider: option(args, "provider") ?? "codex",
      model: option(args, "model"),
      mode: args.flags.worktree ? "worktree" : "local",
      cwd: process.cwd(),
    },
    client,
    signal,
  );
  await mutationResult(args, admission);
  return admission.threadId;
}
export function runThreadId(id: string) {
  return ThreadId.parse(`cli-${createHash("sha256").update(id).digest("hex")}`);
}
export async function admitWork(
  input: {
    text: string;
    id: string;
    project: string | undefined;
    provider: string;
    model: string | undefined;
    mode: "local" | "worktree";
    cwd: string;
  },
  client: Client,
  signal: AbortSignal,
  submit: typeof command = command,
) {
  const { project, id } = input;
  const provider = ProviderKind.parse(input.provider);
  let workspaceId: string;
  if (project && !project.includes("/") && !project.startsWith("."))
    workspaceId = WorkspaceId.parse(project);
  else {
    const path = resolve(project ?? input.cwd);
    const receipt = await addProject(
      client,
      path,
      `project-${createHash("sha256").update(path).update("\0").update(id).digest("hex")}`,
      signal,
      submit,
    );
    if (!receipt.workspace)
      throw new CliFailure("uncertain", "Workspace registration returned no identity");
    workspaceId = receipt.workspace.id;
  }
  // Caller-owned thread identity makes a retried run stable, even before admission completes.
  const threadId = runThreadId(id);
  const receipt = await submit(
    client,
    {
      type: "thread.create",
      workspaceId,
      threadId,
      provider,
      model: input.model,
      mode: input.mode,
      input: [{ type: "text", text: input.text }],
    },
    id,
    signal,
  );
  return {
    type: "admission" as const,
    ok: true,
    status: "accepted" as const,
    commandId: id,
    idempotencyKey: id,
    threadId: receipt.threadId ?? threadId,
  };
}
