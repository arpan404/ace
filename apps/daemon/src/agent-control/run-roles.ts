import { applyRole, type ResolvedRole } from "@ace/offshift";
import { PublicToolError } from "@ace/mcp-server";
import type { DelegationTask, McpAttribution } from "@ace/protocol";
import type { OffshiftRole } from "@ace/protocol/offshift";
import { AgentControlError } from "./failure.ts";

type Lookup = (caller: McpAttribution, role: OffshiftRole) => ResolvedRole | undefined;
/** The role a task was filled from, so a refusal downstream can name it. */
export interface FilledRole {
  name: OffshiftRole;
  resolved: ResolvedRole;
}

const setHint =
  'Set it with offshift action "roles" (on the run, or with scope "project"), pass provider and model on the task, or leave runRole out to use your own provider.';

/**
 * A delegate task with its runRole applied and removed. A task that names a provider or model
 * needs no role; a role that is set nowhere is refused, never quietly replaced by the caller's
 * own provider.
 */
export function roleTask(
  task: DelegationTask,
  caller: McpAttribution,
  lookup: Lookup | undefined,
): { task: Omit<DelegationTask, "runRole">; role?: FilledRole } {
  const { runRole, ...rest } = task;
  if (!runRole) return { task: rest };
  const resolved = lookup?.(caller, runRole);
  const chosen = rest.provider !== undefined || rest.model !== undefined;
  if (!resolved && chosen) return { task: rest };
  if (!resolved)
    throw new AgentControlError(
      "invalid_arguments",
      "run_role_unset",
      undefined,
      `runRole "${runRole}" is not set on your active Offshift run or as a project default. ${setHint}`,
    );
  return { task: applyRole(rest, resolved), role: { name: runRole, resolved } };
}

const describe = (role: FilledRole) => {
  const { provider, model, effort } = role.resolved.selection;
  return [provider, model, effort].filter(Boolean).join(" ");
};

/**
 * Run `work`; when it refuses a task filled from a role, say which role chose what, and how to
 * change it, in front of the original reason.
 */
export async function withRoleContext<T>(
  role: FilledRole | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!role || !(error instanceof AgentControlError || error instanceof PublicToolError))
      throw error;
    const reason = error instanceof AgentControlError ? error.publicDetail : error.detail;
    throw new AgentControlError(
      error.code,
      error.message,
      error,
      `runRole "${role.name}" (${role.resolved.source} role) chose ${describe(role)}, which cannot run: ${reason ?? error.message}. Change it with offshift action "roles", or pass provider and model on the task.`,
    );
  }
}
