import { ClientError, type ClientApi } from "@ace/client";
import {
  ThreadId,
  type CommandPayload,
  type CommandResult,
  type SourceControlContext,
  type SourceControlDraft,
  type SourceControlSelection,
  type WorkspaceActionRequest,
  type WorkspaceActionResult,
} from "@ace/protocol";
import { actionErrorText } from "@ace/ui-core";
import { readPushRemote } from "@/lib/project-repositories.ts";
import type { GitDiffReply, GitStatusReply } from "./source-control-model.ts";

type Operation = WorkspaceActionRequest["operation"];
type Result = WorkspaceActionResult["result"];

/** Typed failure from a Source control read or write, carrying the daemon's refusal code. */
export class SourceControlError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(actionErrorText(code));
    this.name = "SourceControlError";
    this.code = code;
  }
}

const clientCodes: Partial<Record<ClientError["code"], string>> = {
  offline: "offline",
  timeout: "timeout",
  not_dispatched: "action_not_dispatched",
};

export function sourceControlErrorCode(error: unknown): string | undefined {
  if (error instanceof SourceControlError) return error.code;
  if (error instanceof ClientError)
    return error.code === "daemon" ? error.message : clientCodes[error.code];
  return undefined;
}

export function sourceControlErrorText(error: unknown): string {
  return actionErrorText(sourceControlErrorCode(error));
}

async function readWorkspace<K extends Result["kind"]>(
  client: ClientApi,
  operation: Operation,
  kind: K,
  options?: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
): Promise<Extract<Result, { kind: K }>> {
  const reply = await client.request(
    { type: "workspace.request", operation },
    {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    },
  );
  const result = reply.result;
  if (result.kind === "error") throw new SourceControlError(result.code);
  if (result.kind !== kind) throw new SourceControlError("action_failed");
  return result as Extract<Result, { kind: K }>;
}

async function runWorkspace(client: ClientApi, payload: CommandPayload): Promise<CommandResult> {
  const result = await client.command(payload);
  if (!result.ok) throw new SourceControlError(result.error ?? "action_failed");
  return result;
}

const tid = (threadId: string) => ThreadId.parse(threadId);

export function readSourceControlStatus(
  client: ClientApi,
  threadId: string,
  signal?: AbortSignal,
): Promise<GitStatusReply> {
  return readWorkspace(client, { op: "git.status", threadId: tid(threadId) }, "gitStatus", {
    signal,
  });
}

export function readFileGitDiff(
  client: ClientApi,
  threadId: string,
  options: { path: string; stage: "staged" | "unstaged"; from?: string | undefined },
  signal?: AbortSignal,
): Promise<GitDiffReply> {
  return readWorkspace(
    client,
    {
      op: "git.diff",
      threadId: tid(threadId),
      path: options.path,
      stage: options.stage,
      ...(options.from ? { from: options.from } : {}),
    },
    "gitDiff",
    { signal },
  );
}

export function stageFiles(
  client: ClientApi,
  threadId: string,
  paths?: readonly string[],
): Promise<CommandResult> {
  return runWorkspace(client, {
    type: "git.stage",
    threadId: tid(threadId),
    ...(paths ? { paths: [...paths] } : {}),
  });
}

export function unstageFiles(
  client: ClientApi,
  threadId: string,
  paths?: readonly string[],
): Promise<CommandResult> {
  return runWorkspace(client, {
    type: "git.unstage",
    threadId: tid(threadId),
    ...(paths ? { paths: [...paths] } : {}),
  });
}

export function commitChanges(
  client: ClientApi,
  threadId: string,
  options: {
    message: string;
    expectedHead: string | null;
    expectedIndex?: string | undefined;
    reviewed?: readonly { path: string; fingerprint: string }[] | undefined;
    stagedOnly?: boolean | undefined;
    amend?: boolean | undefined;
    amendPublished?: boolean | undefined;
    draftFingerprint?: string | undefined;
  },
): Promise<CommandResult> {
  return runWorkspace(client, {
    type: "git.commit",
    threadId: tid(threadId),
    message: options.message,
    expectedHead: options.expectedHead,
    ...(options.expectedIndex ? { expectedIndex: options.expectedIndex } : {}),
    ...(options.reviewed?.length
      ? {
          reviewed: options.reviewed.map((file) => ({
            path: file.path,
            fingerprint: file.fingerprint,
          })),
        }
      : {}),
    ...(options.stagedOnly ? { stagedOnly: true } : {}),
    ...(options.amend ? { amend: true } : {}),
    ...(options.amendPublished ? { amendPublished: true } : {}),
    ...(options.draftFingerprint ? { draftFingerprint: options.draftFingerprint } : {}),
  });
}

export async function pushChanges(client: ClientApi, threadId: string): Promise<CommandResult> {
  const remote = (await readPushRemote(client)) ?? "origin";
  return runWorkspace(client, {
    type: "git.push",
    threadId: tid(threadId),
    remote,
  });
}

export function fetchRemote(client: ClientApi, threadId: string): Promise<CommandResult> {
  return runWorkspace(client, {
    type: "git.fetch",
    threadId: tid(threadId),
  });
}

export function clearStaleGitLock(client: ClientApi, threadId: string): Promise<CommandResult> {
  return client.command({ type: "git.lock.clear", threadId: tid(threadId) });
}

export async function generateCommitDraft(
  client: ClientApi,
  threadId: string,
  options: { generationId: string; selection: SourceControlSelection },
  signal?: AbortSignal,
): Promise<{ draft: SourceControlDraft; context: SourceControlContext }> {
  const { context } = await readWorkspace(
    client,
    { op: "git.draft.context", threadId: tid(threadId), selection: options.selection },
    "draftContext",
    { signal },
  );
  const { draft, context: finalContext } = await readWorkspace(
    client,
    {
      op: "git.draft.generate",
      threadId: tid(threadId),
      input: {
        generationId: options.generationId,
        selection: options.selection,
        fingerprint: context.fingerprint,
        preference: "",
      },
    },
    "draft",
    { signal, timeoutMs: 150_000 },
  );
  return { draft, context: finalContext };
}

export function cancelCommitDraft(
  client: ClientApi,
  threadId: string,
  generationId: string,
): Promise<void> {
  return readWorkspace(
    client,
    { op: "git.draft.cancel", threadId: tid(threadId), generationId },
    "draftCancelled",
  ).then(
    () => undefined,
    () => undefined,
  );
}
