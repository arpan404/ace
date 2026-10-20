import type { ProviderKind, RunRole } from "@ace/protocol";

/** One role the person set in Settings → Roles; unset fields are left out. */
export interface SessionRole {
  provider: ProviderKind;
  model?: string | undefined;
  effort?: string | undefined;
  tier?: string | undefined;
}
export type SessionRoles = Partial<Record<RunRole, SessionRole>>;

const order: readonly RunRole[] = ["build", "judgment", "review", "verify"];
/** A model id as one bounded word, so a stored value cannot add lines or prose. */
const word = (text: string) => text.replace(/\s+/g, "").slice(0, 64);

/**
 * The person's roles as one line for a session's instructions, or undefined when none is set.
 * Pure and deterministic: a session renders it once, so its instruction prefix stays cached.
 */
export function renderRoles(roles: SessionRoles): string | undefined {
  const set = order.flatMap((role) => {
    const choice = roles[role];
    if (!choice) return [];
    const fields = [choice.provider, choice.model, choice.effort, choice.tier];
    return [[role, ...fields.filter((field) => field).map((field) => word(field ?? ""))].join(" ")];
  });
  return set.length ? `Roles: ${set.join(" · ")}. Delegate with runRole.` : undefined;
}
