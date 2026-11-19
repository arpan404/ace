import type { CommandResult, CommandRunner } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { ForgeMutationOutcome, MutationDispatch, refusedWriteStatuses } from "./mutation.ts";

/** Bitbucket Cloud's API origin; `next` links name it, and nothing else is ever followed. */
const apiOrigin = "https://api.bitbucket.org";

/** A Bitbucket Cloud repository's API path, `/2.0/repositories/<workspace>/<slug>`. */
export function bitbucketRepoPath(repository: { owner: string; name: string }): string {
  return `/2.0/repositories/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

/** bkt prints a 2xx body on stdout; a refusal's status reaches `http` from its stderr. */
export function bktResponse(result: CommandResult): unknown {
  if (result.truncated) throw new ForgeError("limit");
  if (result.unreachable) throw new ForgeError("offline");
  if (result.code !== 0) {
    const status = result.http?.status;
    if (status === 429) throw new ForgeError("rate_limit");
    if (status === 401 || status === 403) throw new ForgeError("forbidden");
    if (status === 404 || status === 410) throw new ForgeError("not_found");
    throw new ForgeError("cli");
  }
  if (!result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ForgeError("invalid_data");
  }
}

/** One GET, exactly `bkt api <endpoint> --method GET --context <context>`. */
export async function bktGet(
  runner: CommandRunner,
  context: string,
  endpoint: string,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  try {
    const result = await runner({
      command: "bkt",
      args: ["api", endpoint, "--method", "GET", "--context", context],
      mode: "json",
      signal,
    });
    return bktResponse(result);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ForgeError) throw error;
    throw new ForgeError("cli");
  }
}

/**
 * A page's `next` link as an endpoint ace may read: on the API origin, under the same path as
 * the page that named it, with only its query changed. Anything else is invalid data.
 */
export function nextEndpoint(next: string | undefined, endpoint: string): string | undefined {
  if (next === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    throw new ForgeError("invalid_data");
  }
  const path = endpoint.split("?")[0];
  if (url.origin !== apiOrigin || url.username || url.password || url.hash || url.pathname !== path)
    throw new ForgeError("invalid_data");
  return `${url.pathname}${url.search}`;
}

/**
 * The one bkt write: exactly `bkt api <endpoint> --method <METHOD> --context <context>`, with
 * `--input <JSON object>` when it has a body (bkt reads a body from no other place). Only an
 * explicit refusal (400, 401, 403, 404, 405, 409, 412, 422, 429) seen under an unchanged
 * identity has definitely failed, and tells `dispatch` so; any other failure once sent, and an
 * identity change after any reply, is uncertain. Pass `dispatch` only for the journaled write.
 */
export async function bktWrite(
  runner: CommandRunner,
  context: string,
  endpoint: string,
  method: "POST" | "PUT" | "DELETE",
  body: object | undefined,
  signal: AbortSignal,
  dispatch: MutationDispatch = new MutationDispatch(),
): Promise<unknown> {
  signal.throwIfAborted();
  try {
    const result = await runner({
      command: "bkt",
      args: [
        "api",
        endpoint,
        "--method",
        method,
        "--context",
        context,
        ...(body === undefined ? [] : ["--input", JSON.stringify(body)]),
      ],
      mode: "json",
      signal,
      dispatch,
    });
    if (result.identityChanged) throw new ForgeMutationOutcome({ dispatched: true });
    const status = result.http?.status;
    if (result.code !== 0 && status !== undefined && refusedWriteStatuses.has(status)) {
      const definite = new ForgeError(refusalKind(status), undefined, false);
      dispatch.reject(definite);
      throw definite;
    }
    return bktResponse(result);
  } catch (error) {
    throw dispatch.failure(error);
  }
}

function refusalKind(status: number) {
  if (status === 409) return "conflict";
  if (status === 422) return "unprocessable";
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "cli";
}
