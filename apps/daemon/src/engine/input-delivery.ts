import { isDeepStrictEqual } from "node:util";
import type { ExecutionOptions } from "@ace/protocol";

/** Model and options selections belong to a settled turn boundary. */
export function hasNextTurnSelection(input: { model?: unknown; options?: unknown }): boolean {
  return input.model !== undefined || input.options !== undefined;
}

/**
 * A send that names only the model and options the thread already runs on changes nothing.
 * Clients may restate them (the composer pins the resolved effort); such a send must not wait
 * for the next turn or for the whole tree as a real selection does.
 */
export function restatesSelection(
  current: { model?: string | undefined; options: ExecutionOptions } | undefined,
  input: { model?: string | undefined; options?: ExecutionOptions | undefined },
): boolean {
  if (!current || !hasNextTurnSelection(input)) return false;
  return (
    (input.model === undefined || input.model === current.model) &&
    (input.options === undefined || isDeepStrictEqual(input.options, current.options))
  );
}
