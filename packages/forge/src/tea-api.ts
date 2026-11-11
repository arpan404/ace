import type { CommandRunner, CommandResult } from "./command.ts";
import { ForgeError } from "./errors.ts";
import { ForgeMutationOutcome, MutationDispatch } from "./mutation.ts";

/** Statuses after which Gitea has certainly not applied a write; the same rule as GitLabApi. */
const refused = new Set([400, 401, 403, 404, 405, 409, 412, 422, 429]);

/** A Gitea or Forgejo repository's API path, `repos/<owner>/<name>`: every endpoint's prefix. */
export function teaRepoPath(repository: { owner: string; name: string }): string {
  return `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

/** tea keeps the body on stdout and --include HTTP metadata on stderr. */
export function teaResponse(result: CommandResult): unknown {
  if (result.truncated) throw new ForgeError("limit");
  if (result.unreachable) throw new ForgeError("offline");
  const status = result.http?.status;
  if (status === undefined) throw new ForgeError("invalid_data");
  if (status === 429 || (status === 403 && result.http?.headers["x-ratelimit-remaining"] === "0"))
    throw new ForgeError("rate_limit");
  if (status === 401 || status === 403) throw new ForgeError("forbidden");
  if (status === 404) throw new ForgeError("not_found");
  if (status < 200 || status >= 300 || result.code !== 0) throw new ForgeError("cli");
  if (status === 204 && !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ForgeError("invalid_data");
  }
}

export async function teaGet(
  runner: CommandRunner,
  login: string,
  endpoint: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  try {
    const result = await runner({
      command: "tea",
      args: ["api", endpoint, "--method", "GET", "--login", login, "--include"],
      mode: "json",
      signal,
    });
    return { body: teaResponse(result), total: totalCount(result) };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ForgeError) throw error;
    throw new ForgeError("cli");
  }
}
function totalCount(result: CommandResult): number | undefined {
  const raw = result.http?.headers["x-total-count"];
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * The one tea write: exactly `tea api <endpoint> --method <METHOD> --login <login> --include
 * --data @-` with a JSON object on stdin (ADR 0117). Only an explicit refusal (400, 401, 403,
 * 404, 405, 409, 412, 422, 429) seen under an unchanged identity has definitely failed, and
 * tells `dispatch` so; any other failure once sent, and an identity change after any reply,
 * is uncertain. Pass `dispatch` only for the write the caller journals: a later call of a
 * multi-call write gets its own, so its refusal can't settle the first as failed. An empty
 * reply body is `null`.
 */
export async function teaWrite(
  runner: CommandRunner,
  login: string,
  endpoint: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body: object,
  signal: AbortSignal,
  dispatch: MutationDispatch = new MutationDispatch(),
): Promise<unknown> {
  signal.throwIfAborted();
  try {
    const result = await runner({
      command: "tea",
      args: ["api", endpoint, "--method", method, "--login", login, "--include", "--data", "@-"],
      input: JSON.stringify(body),
      mode: "json",
      signal,
      dispatch,
    });
    const status = result.http?.status;
    if (result.identityChanged) throw new ForgeMutationOutcome({ dispatched: true });
    if (status !== undefined && refused.has(status) && !result.truncated) {
      const kind = refusalKind(status, endpoint, result);
      const definite = new ForgeError(kind, undefined, false);
      dispatch.reject(definite);
      throw definite;
    }
    if (status !== undefined && status >= 200 && status < 300 && !result.stdout.trim()) return null;
    return teaResponse(result);
  } catch (error) {
    throw dispatch.failure(error);
  }
}

function refusalKind(status: number, endpoint: string, result: CommandResult) {
  if (status === 409) return endpoint.endsWith("/merge") ? "head_moved" : "conflict";
  if (status === 422) return "unprocessable";
  if (status === 429 || (status === 403 && result.http?.headers["x-ratelimit-remaining"] === "0"))
    return "rate_limit";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "cli";
}
