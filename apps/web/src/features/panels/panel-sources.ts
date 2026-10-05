import type { ClientApi } from "@ace/client";
import { daemonPreview } from "./preview/daemon-preview.ts";

import { daemonTerminals } from "./terminal/daemon-terminals.ts";
import { TerminalSessions } from "./terminal/sessions.ts";

/**
 * The terminal and browser services for one client, over the daemon's wire messages. Loaded
 * the first time a panel needs them, so the thread screen's first paint doesn't carry them.
 */
export function createPanelSources(client: ClientApi) {
  const terminals = new TerminalSessions(daemonTerminals(client));
  return { terminals, preview: daemonPreview(client) };
}
