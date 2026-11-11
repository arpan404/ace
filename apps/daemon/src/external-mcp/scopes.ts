/*
 * What each outside grant scope allows (ADR 0117): the one table of outside tools and the scope
 * each needs, and the checks every path uses. Pure: listing, calls and the HTTP 403 challenge
 * all read this module, so they can never disagree.
 */
import { bareToolName } from "@ace/mcp-server";
import { OutsideScope, type OutsideProjects, type WorkspaceId } from "@ace/protocol";

/** The scope every outside thread tool needs, by bare tool name (`ace_threads_list` is `threads_list`). */
const threadTools: Readonly<Record<string, OutsideScope>> = {
  projects_list: "threads:read",
  models_list: "threads:read",
  threads_list: "threads:read",
  thread_read: "threads:read",
  thread_status: "threads:read",
  thread_run: "threads:start",
  thread_send: "threads:message",
  thread_stop: "threads:stop",
  // Listed with read; each operation below needs its own scope.
  task_control: "threads:read",
};
/** `ace_task_control` operations that change something, and the scope each needs. */
const taskOperations: Readonly<Record<string, OutsideScope>> = {
  "task.spawn": "threads:start",
  "task.cancel": "threads:stop",
  "task.status": "threads:read",
};

/**
 * The scope a tool needs before any argument is read; undefined for a tool outside clients are
 * never offered.
 */
export function toolScope(tool: string): OutsideScope | undefined {
  const name = bareToolName(tool);
  if (Object.hasOwn(threadTools, name)) return threadTools[name];
  if (name.startsWith("browser_")) return "browser";
  if (name.startsWith("screen_")) return "computer";
  return undefined;
}

/** The scope one call needs, its arguments included (`ace_task_control` names its operation). */
export function callScope(tool: string, args: unknown): OutsideScope | undefined {
  const base = toolScope(tool);
  if (bareToolName(tool) !== "task_control") return base;
  const operation = typeof args === "object" && args !== null ? Reflect.get(args, "operation") : {};
  const op =
    typeof operation === "object" && operation !== null ? Reflect.get(operation, "op") : "";
  // An operation this table doesn't know needs the widest thread scope; parsing refuses it anyway.
  return typeof op === "string" && Object.hasOwn(taskOperations, op)
    ? taskOperations[op]
    : "threads:start";
}

/** The scope `scopes` lacks for this call, or undefined when the grant allows it. */
export function missingScope(
  scopes: readonly OutsideScope[],
  tool: string,
  args: unknown,
): OutsideScope | undefined {
  const needed = callScope(tool, args);
  if (!needed) return undefined;
  return scopes.includes(needed) ? undefined : needed;
}

/** Of `tools`, the bare names of those a grant with `scopes` is not offered. */
export function withheldTools(scopes: readonly OutsideScope[], tools: readonly string[]): string[] {
  return tools
    .filter((tool) => {
      const needed = toolScope(tool);
      return needed === undefined || !scopes.includes(needed);
    })
    .map(bareToolName);
}

/** Scopes in table order, each once, read always included. */
export function normalScopes(scopes: readonly OutsideScope[]): OutsideScope[] {
  const wanted = new Set<OutsideScope>(["threads:read", ...scopes]);
  return OutsideScope.options.filter((scope) => wanted.has(scope));
}

/** The scopes `ace mcp enroll --scope read|operate` stood for before scopes were split. */
export function shorthandScopes(scope: "read" | "operate"): OutsideScope[] {
  return scope === "read"
    ? ["threads:read"]
    : ["threads:read", "threads:start", "threads:message", "threads:stop"];
}

/** Whether a grant's project limit includes this project. */
export function projectAllowed(projects: OutsideProjects, project: WorkspaceId): boolean {
  return projects === "all" || projects.includes(project);
}
