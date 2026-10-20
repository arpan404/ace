import { logError, logFields, type ComponentLogger } from "@ace/diagnostics";
import { ErrorId, type ToolFailureReporter } from "@ace/mcp-server";
import type { McpAttribution } from "@ace/protocol";

type Log = Pick<ComponentLogger, "log">;

/** The call frames of an error's stack: code locations only, never its message line. */
export function stackFrames(error: unknown): string | undefined {
  let stack: unknown;
  try {
    stack = error instanceof Error ? error.stack : undefined;
  } catch {
    return undefined;
  }
  if (typeof stack !== "string") return undefined;
  const frames = stack
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 16)
    .map((line) => line.trim().slice(0, 240));
  return frames.length ? frames.join("\n").slice(0, 2000) : undefined;
}

/** The error's own class name ("TypeError", "SqliteError"), which the summary reduces to Error. */
function errorName(error: unknown): string | undefined {
  try {
    const name = error instanceof Error ? error.name : undefined;
    return typeof name === "string" && /^[\w$.-]{1,64}$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Logs a tool failure whose cause the agent never sees, under a fresh correlation id the agent's
 * result carries. Message text goes through the logger's redaction like every other record.
 */
export function logToolFailure(
  log: Log,
  id: () => string,
  failure: { tool: string; caller: McpAttribution; error: unknown; code?: string },
): string | undefined {
  const errorId = ErrorId.safeParse(id()).data;
  const name = errorName(failure.error);
  const stack = stackFrames(failure.error);
  log.log(
    "error",
    "Tool failed",
    logFields([
      ...(errorId ? [["errorId", errorId] as const] : []),
      ["tool", failure.tool],
      ["threadId", failure.caller.threadId],
      ...(failure.code ? [["code", failure.code] as const] : []),
      ["error", logError(failure.error)],
      ...(name ? [["errorName", name] as const] : []),
      ...(stack ? [["stack", stack] as const] : []),
    ]),
  );
  return errorId;
}

/** The registry hook: every unexpected tool error is logged and named by its errorId. */
export function toolFailureReporter(log: Log, id: () => string): ToolFailureReporter {
  return (failure) => logToolFailure(log, id, failure);
}
