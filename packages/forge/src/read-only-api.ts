import type { CommandRequest } from "./command.ts";

/** CLIs ace reads hosts through without admitting any write. */
export type ReadOnlyCli = "glab" | "origin";

const bodyFlag = /^(?:-[fF]|--field|--raw-field|--input|--verbose)/;
const methodFlag = /^(?:-X|--method)$/;
const joinedMethod = /^(?:-X.|--method=)/;

/**
 * Whether `request` is one explicit GET through `cli api`: `api` first, an endpoint that isn't a
 * flag, at least one `-X`/`--method` and every one of them GET, and no request body, field or
 * verbose flag (`--verbose` echoes headers, including credentials). Anything else is refused,
 * never rewritten. Pure policy: the runner that dispatches decides what refusal means.
 */
export function isReadOnlyApiRequest(
  cli: ReadOnlyCli,
  request: Pick<CommandRequest, "command" | "args" | "input">,
): boolean {
  const args = request.args;
  if (request.command !== cli || request.input !== undefined) return false;
  if (args[0] !== "api" || !args[1] || args[1].startsWith("-")) return false;
  let methods = 0;
  for (let index = 2; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (bodyFlag.test(arg) || joinedMethod.test(arg)) return false;
    if (methodFlag.test(arg)) {
      if (args[index + 1] !== "GET") return false;
      methods++;
      index++;
    }
  }
  return methods > 0;
}
