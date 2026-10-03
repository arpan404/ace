import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { daemonCommandSource, type CommandSource } from "./command-source.ts";
import { daemonContextSource, type ContextSource } from "./context-source.ts";
import { daemonThreadActions, type ThreadActionsSource } from "./thread-actions-source.ts";
import { daemonWorkspaceSource, type WorkspaceSource } from "./workspace-source.ts";

/**
 * What the thread screen reads or does beyond the live thread store. Slash commands, mentions,
 * uploads, thread organization and the checkout's scripts, editors, git and forge all go to the
 * daemon in every mode; fake mode gets the same behaviour from @ace/fake-daemon.
 */
export interface ThreadSources {
  workspace: WorkspaceSource;
  context: ContextSource;
  commands: CommandSource;
  actions: ThreadActionsSource;
}

function createSources(client: ClientApi): ThreadSources {
  return {
    workspace: daemonWorkspaceSource(client),
    actions: daemonThreadActions(client),
    context: daemonContextSource(client),
    commands: daemonCommandSource(client),
  };
}

// One set per client, so each connection (and each test's client) gets its own state.
const perClient = new WeakMap<ClientApi, ThreadSources>();

export function useThreadSources(): ThreadSources {
  const client = useClient();
  let sources = perClient.get(client);
  if (!sources) {
    sources = createSources(client);
    perClient.set(client, sources);
  }
  return sources;
}

export type { ThreadRef } from "./workspace-source.ts";
export type { Selection } from "./thread-actions-source.ts";
