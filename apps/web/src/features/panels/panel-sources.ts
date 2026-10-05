import type { ClientApi } from "@ace/client";
import { daemonPreview } from "./preview/daemon-preview.ts";
import { onTerminalEnd, onTerminalProbe } from "./terminal/closing.ts";
import { daemonTerminals } from "./terminal/daemon-terminals.ts";
import { TerminalSessions } from "./terminal/sessions.ts";

/**
 * The terminal and browser services for one client, over the daemon's wire messages. Loaded
 * the first time a panel needs them, so the thread screen's first paint doesn't carry them.
 */
export function createPanelSources(client: ClientApi) {
  const terminals = new TerminalSessions(daemonTerminals(client));
  // A closed terminal tab ends its shell (the tab kind's onClose has no client to ask).
  onTerminalEnd((end) => terminals.end(end.threadId, end.terminalId));
  // Closing a tab whose shell has already exited needs no confirmation.
  onTerminalProbe((threadId, terminalId) => {
    if (terminals.exitCode(terminalId) !== null) return true;
    return terminals.source.list(threadId).find((terminal) => terminal.id === terminalId)?.exited;
  });
  return { terminals, preview: daemonPreview(client) };
}
