import { scopedSelection, type ModelScope } from "@ace/client";
import {
  AgentLaunchOptions,
  WorkspaceId,
  type AccessMode,
  type CommandPayload,
  type ContentPart,
  type ForgeIssueRef,
  type ForgePrWorktree,
  type MessageContext,
  type WorktreeBase,
} from "@ace/protocol";
import { baseName } from "./worktree-base.ts";

/** Everything New thread decided, on any client: web, desktop and the native apps. */
export interface CreateRequest {
  pullRequest?: ForgePrWorktree | undefined;
  issue?: ForgeIssueRef | undefined;
  project: string;
  /** The composer's own draft key, retained until the original create settles. */
  draftKey?: string | undefined;
  /** The account the thread runs on: picked first, before its model. */
  scope: ModelScope;
  /** The catalog id listed on that account (OpenCode's `provider/model`), never a bare native id. */
  model: string;
  mode: "local" | "worktree";
  /** Where a worktree starts, a local or a remote branch; ignored for the local checkout. */
  base: WorktreeBase | undefined;
  effort: string | undefined;
  /** The faster tier to run on (`serviceTier`), when the person turned speed on. */
  serviceTier?: string | undefined;
  /** An explicit approval mode for this thread; the daemon's default when omitted. */
  permission?: AccessMode | undefined;
  text: string;
  input?: ContentPart[] | undefined;
  context?: MessageContext | undefined;
}

export type CreatePayload = Extract<CommandPayload, { type: "thread.create" }>;

/**
 * The `thread.create` command for a request: the account's provider, account (or ACP identity)
 * and catalog id, as `ModelClient` would select them. Pure, so it can be saved offline; the
 * daemon resolves the id again at admission.
 */
export function createPayload(request: CreateRequest): CreatePayload {
  const effort = AgentLaunchOptions.shape.effort.safeParse(request.effort);
  const tier = AgentLaunchOptions.shape.serviceTier.safeParse(request.serviceTier);
  const options = {
    ...(effort.success && effort.data ? { effort: effort.data } : {}),
    ...(tier.success && tier.data ? { serviceTier: tier.data } : {}),
  };
  return {
    type: "thread.create",
    ...(request.pullRequest ? { pullRequest: request.pullRequest } : {}),
    ...(request.issue ? { issue: request.issue } : {}),
    workspaceId: WorkspaceId.parse(request.project),
    ...scopedSelection(request.scope, request.model),
    mode: request.pullRequest ? "worktree" : request.mode,
    // `baseBranch` names the same commit for a daemon that doesn't read `base` yet.
    ...(!request.pullRequest && request.mode === "worktree" && request.base
      ? { base: request.base, baseBranch: baseName(request.base) }
      : {}),
    ...(Object.keys(options).length ? { options } : {}),
    ...(request.permission ? { access: request.permission } : {}),
    input: request.input ?? [{ type: "text", text: request.text }],
    ...(request.context ? { context: request.context } : {}),
  };
}
