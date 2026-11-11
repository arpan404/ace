import { WorkspaceId, type DelegationRequest, type McpAttribution } from "@ace/protocol";
import type { Store } from "../store.ts";
import { callerThread } from "./authorization.ts";
import { AgentControlError } from "./failure.ts";
import { resolveProject } from "./projects.ts";

/** Whether the caller acts as a host thread (ADR 0121): Spade, working for the person. */
export function hostCaller(store: Store, caller: McpAttribution): boolean {
  return store.getThread(caller.threadId)?.host !== undefined;
}

/**
 * The project a local delegation runs in: the caller's own, or, for a host thread, the local
 * project its `project` names. Spade's own project is an empty folder, so the work it hands on
 * runs where the person's code is; every other agent keeps to its own project.
 */
export function delegationWorkspace(
  store: Store,
  caller: McpAttribution,
  request: Pick<DelegationRequest, "project" | "machine">,
): WorkspaceId {
  const parent = callerThread(store, caller);
  if (!request.project || request.machine || parent.host === undefined) return parent.workspaceId;
  const target = resolveProject(store, request.project);
  if (!target.ok)
    throw new AgentControlError("invalid_arguments", "project_not_found", undefined, target.hint);
  return WorkspaceId.parse(target.project.id);
}
