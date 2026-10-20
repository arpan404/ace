import { PublicToolError } from "@ace/mcp-server";
import type { DelegationTask, RunRole } from "@ace/protocol";
import type { RoleChoice } from "@ace/settings/roles";
import { AgentControlError } from "./failure.ts";

/** The person's choice for a role, from Settings → Roles; undefined while it is unset. */
export type RoleLookup = (role: RunRole) => RoleChoice | undefined;
/** The role a task was filled from, so a refusal downstream can name it. */
export interface FilledRole {
  name: RunRole;
  choice: RoleChoice;
}
type Task = Omit<DelegationTask, "runRole">;

/**
 * Fill a delegated task from a role. A provider or model on the task is a deliberate choice, so
 * the role's provider, model, effort and tier come as one and the task takes them only when it
 * names neither; its own effort and service tier always win.
 */
export function applyRole(task: Task, role: RoleChoice): Task {
  if (task.provider !== undefined || task.model !== undefined) return task;
  // Delegation offers the priority and flex tiers; any other tier is the provider's default.
  const tier = role.tier === "priority" || role.tier === "flex" ? role.tier : undefined;
  return {
    ...task,
    provider: role.provider,
    ...(role.model ? { model: role.model } : {}),
    ...(task.effort === undefined && role.effort ? { effort: role.effort } : {}),
    ...(tier && task.options?.serviceTier === undefined
      ? { options: { ...task.options, serviceTier: tier } }
      : {}),
  };
}

/**
 * A delegate task with its runRole applied and removed. A task that names a provider or model
 * needs no role; a role the person has not set is refused, never quietly replaced by the
 * caller's own provider.
 */
export function roleTask(
  task: DelegationTask,
  lookup: RoleLookup | undefined,
): { task: Task; role?: FilledRole } {
  const { runRole, ...rest } = task;
  if (!runRole) return { task: rest };
  const choice = lookup?.(runRole);
  if (!choice && (rest.provider !== undefined || rest.model !== undefined)) return { task: rest };
  if (!choice)
    throw new AgentControlError(
      "invalid_arguments",
      "run_role_unset",
      undefined,
      `runRole "${runRole}" is not set. The person sets roles in Settings → Roles; ask them to, pass provider and model on the task, or leave runRole out to use your own provider.`,
    );
  return { task: applyRole(rest, choice), role: { name: runRole, choice } };
}

const describe = ({ provider, model, effort }: RoleChoice) =>
  [provider, model, effort].filter(Boolean).join(" ");

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
      `runRole "${role.name}" chose ${describe(role.choice)} in Settings → Roles, which cannot run: ${reason ?? error.message}. Ask the person to change it there, or pass provider and model on the task.`,
    );
  }
}
