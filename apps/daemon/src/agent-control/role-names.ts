/** Role names become the child's display title. Generic repeats are unreadable. */

const generic = new Set([
  "implementer",
  "implementor",
  "implementation",
  "worker",
  "helper",
  "assistant",
  "agent",
  "task",
  "child",
  "reviewer",
  "review",
  "greeter",
  "reader",
  "writer",
  "planner",
  "executor",
  "coder",
  "developer",
  "fixer",
  "researcher",
  "analyst",
  "tester",
  "builder",
  "runner",
  "handler",
  "processor",
  "subagent",
  "delegate",
  "coordinator",
  "supervisor",
  "manager",
  "consultant",
  "expert",
  "specialist",
  "intern",
  "contractor",
  "bot",
]);

/** Internal callers name work, not agents: automation, handoffs and model switches. */
export function internalRole(role: string): boolean {
  return role.startsWith("automation:") || role.startsWith("handoff:") || role === "configuration";
}

/** Case-insensitive identity for duplicate detection. */
export function normalizeRole(role: string): string {
  return role.trim().toLowerCase();
}

/** A numbered retry ("Implementer 2") is still the same generic name. */
export function genericRoleBase(role: string): string {
  return normalizeRole(role)
    .replace(/[\s_.:-]*(\(.+\)|\[.+\])\s*$/, "")
    .replace(/[\s_.:-]+\d+\s*$/, "");
}

function example(): string {
  return "Use a unique descriptive name for this work, e.g. 'Fix-869-worked-for-toast', not 'Implementer'.";
}

/**
 * Why this role is unusable as a display name, in the agent's words.
 * Internal roles bypass naming rules; uniqueness against siblings is checked
 * at admission, where live children are visible.
 */
export function roleProblem(role: string): string | undefined {
  if (internalRole(role)) return undefined;
  if (!role.trim()) return `role is blank. ${example()}`;
  if (genericRoleBase(role) && generic.has(genericRoleBase(role)))
    return `role '${role.trim()}' is generic${role.trim() === role ? "" : " once trimmed"}. ${example()}`;
  return undefined;
}

/** Duplicate display names among one parent's live children, in the agent's words. */
export function duplicateRoleProblem(role: string): string {
  return `role '${role.trim()}' is already used by a live child of this thread. ${example()}`;
}

/** Duplicate display names inside one delegate batch, in the agent's words. */
export function batchDuplicateRoleProblem(role: string): string {
  return `role '${role.trim()}' appears twice in this batch. ${example()}`;
}
