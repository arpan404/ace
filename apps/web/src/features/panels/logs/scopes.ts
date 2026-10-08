/*
 * The sources a Logs tab can show, as tab ids: the thread (`logs`), one agent with the
 * subagents under it (`agent:<id>`), or the daemon (`daemon`). Strings only: the tab kind's
 * title rule reads this before any Logs code has loaded.
 */

export type LogScope = { kind: "thread" } | { kind: "agent"; agentId: string } | { kind: "daemon" };

const agentPrefix = "agent:";

export function parseLogScope(id: string): LogScope {
  if (id === "daemon") return { kind: "daemon" };
  if (id.startsWith(agentPrefix) && id.length > agentPrefix.length)
    return { kind: "agent", agentId: id.slice(agentPrefix.length) };
  return { kind: "thread" };
}

/** The tab id for a scope; the thread's log is the kind's own tab (no id). */
export function logScopeId(scope: LogScope): string | undefined {
  if (scope.kind === "daemon") return "daemon";
  if (scope.kind === "agent") return `${agentPrefix}${scope.agentId}`;
  return undefined;
}

/** A Logs tab's title: "Logs", "Daemon log", or the agent's name the view last reported. */
export function logScopeTitle(id: string, reported: string | undefined): string {
  const scope = parseLogScope(id);
  if (scope.kind === "daemon") return "ace log";
  if (scope.kind === "agent") return reported ?? "Agent log";
  return "Logs";
}
