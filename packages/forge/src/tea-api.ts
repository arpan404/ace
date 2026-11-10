import type { CommandRunner, CommandResult } from "./command.ts";
import { ForgeError } from "./errors.ts";

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
