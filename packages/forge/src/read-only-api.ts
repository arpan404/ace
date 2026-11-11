import type { CommandRequest } from "./command.ts";

/** CLIs ace reaches non-GitHub hosts through, one exact request shape each. */
export type HostApiCli = "glab" | "origin" | "tea";

/**
 * One write an adapter admits (ADR 0117): an HTTP method and the endpoints it may reach. Each
 * adapter lists its writes next to the code that sends them; nothing else is admitted.
 */
export interface HostApiWrite {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Matched against the whole endpoint, e.g. /^projects\/[^/]+\/issues\/\d+\/notes$/. */
  endpoint: RegExp;
}

/**
 * One adapter's writes pinned under `root`, the exact API path of one repository (and, where
 * known, one pull request or issue): admission itself refuses any other repository. Each
 * `path` is a regular-expression source matched after the root, to the end of the endpoint.
 */
export function writesUnder(
  root: string,
  writes: readonly { method: HostApiWrite["method"]; path: string }[],
): HostApiWrite[] {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return writes.map((write) => ({
    method: write.method,
    endpoint: new RegExp(`^${escaped}${write.path}$`),
  }));
}

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
  cli: HostApiCli,
  request: Pick<CommandRequest, "command" | "args" | "input">,
  host: string,
): boolean {
  const args = request.args;
  if (request.command !== cli || request.input !== undefined) return false;
  const endpoint = args[1];
  if (args[0] !== "api" || !endpoint || endpoint.startsWith("-")) return false;
  if (cli === "tea")
    return (
      teaEndpoint(endpoint) &&
      args.length === 7 &&
      args[2] === "--method" &&
      args[3] === "GET" &&
      args[4] === "--login" &&
      args[5] === host &&
      args[6] === "--include"
    );
  if (cli === "origin") return args.length === 4 && args[2] === "--method" && args[3] === "GET";
  if (args[2] !== "-X" || args[3] !== "GET" || args[4] !== "--hostname" || args[5] !== host)
    return false;
  const rest = args.slice(6);
  return rest.every((arg) => glabOptional.has(arg)) && new Set(rest).size === rest.length;
}

/**
 * Whether `request` is one admitted write: exactly
 * `glab api <endpoint> -X <METHOD> --hostname <host> --include --input -` with a JSON body on
 * stdin, where `<METHOD> <endpoint>` matches one of `writes`. The body travels only on stdin, so
 * no field flags are admitted. Origin writes aren't admitted yet. Pure policy.
 */
export function isAdmittedWriteRequest(
  cli: HostApiCli,
  request: Pick<CommandRequest, "command" | "args" | "input">,
  host: string,
  writes: readonly HostApiWrite[],
): boolean {
  if (request.command !== cli) return false;
  if (cli === "tea") {
    const a = request.args;
    const endpoint = a[1];
    return (
      a.length === 9 &&
      a[0] === "api" &&
      typeof endpoint === "string" &&
      teaEndpoint(endpoint) &&
      a[2] === "--method" &&
      a[4] === "--login" &&
      a[5] === host &&
      a[6] === "--include" &&
      a[7] === "--data" &&
      a[8] === "@-" &&
      typeof request.input === "string" &&
      isJsonObject(request.input) &&
      writes.some(
        (w) =>
          w.method === a[3] &&
          new RegExp(w.endpoint.source, w.endpoint.flags.replace(/[gy]/g, "")).test(endpoint),
      )
    );
  }
  if (cli !== "glab") return false;
  const args = request.args;
  const endpoint = args[1];
  if (args.length !== 9 || args[0] !== "api" || !endpoint || endpoint.startsWith("-")) return false;
  if (args[2] !== "-X" || args[4] !== "--hostname" || args[5] !== host) return false;
  if (args[6] !== "--include" || args[7] !== "--input" || args[8] !== "-") return false;
  if (typeof request.input !== "string" || !isJsonObject(request.input)) return false;
  const method = args[3];
  return writes.some((write) => write.method === method && write.endpoint.test(endpoint));
}

/** Whether a request is any read or admitted write; refusal is the runner's to decide. */
export function isAdmittedApiRequest(
  cli: HostApiCli,
  request: Pick<CommandRequest, "command" | "args" | "input">,
  host: string,
  writes: readonly HostApiWrite[],
): boolean {
  return (
    isReadOnlyApiRequest(cli, request, host) || isAdmittedWriteRequest(cli, request, host, writes)
  );
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** No absolute URLs, placeholders, traversal, fragments or alternate API roots. */
function teaEndpoint(endpoint: string): boolean {
  if (!/^(user|repos\/[A-Za-z0-9_.%-]+\/[A-Za-z0-9_.%-]+)(?:[/?]|$)/.test(endpoint)) return false;
  if (/[\\#{}\s]/.test(endpoint)) return false;
  try {
    const path = decodeURIComponent(endpoint.split("?")[0] ?? "");
    return (
      !path.split("/").some((part) => part === "." || part === "..") &&
      !/[\\?#{}\s]/.test(path) &&
      !/%[0-9a-f]{2}/i.test(path)
    );
  } catch {
    return false;
  }
}
