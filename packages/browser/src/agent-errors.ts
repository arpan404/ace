import { PublicToolError, type PublicToolCode } from "@ace/mcp-server/errors";

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
/** Chromium's network error name, as CDP (`net::ERR_…`) or Electron (`ERR_… (-N)`) word it. */
const netError = /\bnet::(ERR_[A-Z0-9_]+)|\b(ERR_[A-Z0-9_]+) \(-\d+\)/;

/** What a tool returns while a dialog holds its tab, with the way out. */
export const pendingDialogHint =
  "A dialog is open in this tab and holds it: nothing else runs there until it is answered. Answer it with ace_browser_dialog (this dialogId, accept true or false, promptText for a prompt), then retry.";

/**
 * The failure an agent sees for a browser tool. Public failures pass through; a raw engine
 * failure with a known meaning becomes its public code; anything else stays private and is
 * reported as `execution_failed` by the MCP boundary.
 */
export function agentBrowserError(error: unknown): unknown {
  if (error instanceof PublicToolError || !(error instanceof Error)) return error;
  const net = netError.exec(error.message);
  const name = net?.[1] ?? net?.[2];
  if (name)
    return new PublicToolError("page_unreachable", undefined, undefined, undefined, `net::${name}`);
  for (const [pattern, code] of known)
    if (pattern.test(error.message)) return new PublicToolError(code);
  return error;
}
