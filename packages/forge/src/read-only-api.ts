import type { CommandRequest } from "./command.ts";

/** CLIs ace reads hosts through without admitting any write. */
export type ReadOnlyCli = "glab" | "origin";

/** Output-only glab flags a read may add after its fixed prefix, each at most once. */
const glabOptional = new Set(["--include", "--paginate"]);

/**
 * Whether `request` is one explicit GET through `cli api`, matched against an exact allowlist:
 *
 * - glab: `api <endpoint> -X GET --hostname <host> [--include] [--paginate]`, where `<host>` is
 *   the pinned host;
 * - origin: `api <endpoint> --method GET` (Origin has one API host, so no hostname).
 *
 * The endpoint can't be a flag, and nothing else is admitted: no flag clusters, headers, fields,
 * extra positionals, other hosts or stdin. Anything else is refused, never rewritten. Pure
 * policy: the runner that dispatches decides what refusal means.
 */
export function isReadOnlyApiRequest(
  cli: ReadOnlyCli,
  request: Pick<CommandRequest, "command" | "args" | "input">,
  host: string,
): boolean {
  const args = request.args;
  if (request.command !== cli || request.input !== undefined) return false;
  const endpoint = args[1];
  if (args[0] !== "api" || !endpoint || endpoint.startsWith("-")) return false;
  if (cli === "origin") return args.length === 4 && args[2] === "--method" && args[3] === "GET";
  if (args[2] !== "-X" || args[3] !== "GET" || args[4] !== "--hostname" || args[5] !== host)
    return false;
  const rest = args.slice(6);
  return rest.every((arg) => glabOptional.has(arg)) && new Set(rest).size === rest.length;
}
