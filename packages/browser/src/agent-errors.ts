import { PublicToolError, type PublicToolCode } from "@ace/mcp-server/errors";
import { ChromeLaunchError, launchProblemDetail } from "./launch-failure.ts";

/**
 * Raw failures from the browser engines that have a public meaning. Their messages are ours or
 * Chromium's fixed texts; none of them reaches the agent, only the code (and a net error name).
 */
const known: [RegExp, PublicToolCode][] = [
  // The daemon's Chrome died or wedged; it restarts and reopens the tab at its last address.
  [
    /^The browser (stopped|exited)|^Browser pipe closed|^Browser closed during recovery/,
    "browser_restarted",
  ],
  [
    /^Desktop browser (backend|session) (lost|closed)|^Browser target detached|^Browser tab unavailable/,
    "backend_changed",
  ],
  [
    /^Chrome failed to start|^No pinned ace Chromium|^Chromium (download failed|archive|cache|executable)|^Invalid Chromium|^Embedded browser unavailable/,
    "browser_unavailable",
  ],
  // Before timeouts: a script that ran too long is the script's failure.
  [/^Browser evaluate failed|^Read-only evaluation refused/, "evaluate_failed"],
  [/timed out|^The page did not reopen in time/, "timeout"],
];
/** A failed start of ace's Chrome, however deep a recovery or open wrapped it. */
function launchError(error: Error): ChromeLaunchError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof ChromeLaunchError) return current;
    current = current.cause;
  }
  return undefined;
}
/** Chromium's network error name, as CDP (`net::ERR_…`) or Electron (`ERR_… (-N)`) word it. */
const netError = /\bnet::(ERR_[A-Z0-9_]+)|\b(ERR_[A-Z0-9_]+) \(-\d+\)/;

/**
 * The failure an agent sees for a browser tool. Public failures pass through; a raw engine
 * failure with a known meaning becomes its public code; anything else stays private and is
 * reported as `execution_failed` by the MCP boundary.
 */
export function agentBrowserError(error: unknown): unknown {
  if (error instanceof PublicToolError || !(error instanceof Error)) return error;
  const launch = launchError(error);
  if (launch) {
    const problem = launch.problem;
    const detail = launchProblemDetail(problem);
    const code: PublicToolCode =
      problem.kind === "missing_libraries"
        ? "browser_missing_libraries"
        : problem.kind === "sandbox_blocked" || problem.kind === "running_as_root"
          ? "browser_sandbox_blocked"
          : "browser_unavailable";
    return new PublicToolError(code, undefined, undefined, undefined, detail);
  }
  const net = netError.exec(error.message);
  const name = net?.[1] ?? net?.[2];
  if (name)
    return new PublicToolError("page_unreachable", undefined, undefined, undefined, `net::${name}`);
  for (const [pattern, code] of known)
    if (pattern.test(error.message)) return new PublicToolError(code);
  return error;
}
