import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { daemonCommandSource, type CommandSource } from "./command-source.ts";
import { daemonContextSource, type ContextSource } from "./context-source.ts";
import { daemonThreadActions, type ThreadActionsSource } from "./thread-actions-source.ts";
import { unavailableWorkspaceSource } from "./unavailable.ts";
import { fakeWorkspaceSource, type WorkspaceSource } from "./workspace-source.ts";

/**
 * What the thread screen reads or does beyond the live thread store. Slash commands, mentions,
 * uploads and thread organization go to the daemon in every mode. Workspace actions have no
 * protocol on main yet: the fake daemon's stand-ins serve dev:fake and tests, and a real daemon
 * gets sources that report them unavailable.
 */
export interface ThreadSources {
  workspace: WorkspaceSource;
  context: ContextSource;
  commands: CommandSource;
  actions: ThreadActionsSource;
}

function createSources(client: ClientApi, fake: boolean): ThreadSources {
  return {
    // TODO(client-gaps): feat/client-protocol-gaps routes workspace commands.
    workspace: fake ? fakeWorkspaceSource() : unavailableWorkspaceSource(),
    actions: daemonThreadActions(client),
    context: daemonContextSource(client),
    commands: daemonCommandSource(client),
  };
}

// One set per client, so each connection (and each test's client) gets its own state.
const perClient = new WeakMap<ClientApi, ThreadSources>();

export function useThreadSources(): ThreadSources {
  const client = useClient();
  const fake = useDaemonConnection().mode === "fake";
  let sources = perClient.get(client);
  if (!sources) {
    sources = createSources(client, fake);
    perClient.set(client, sources);
  }
  return sources;
}

export type { ThreadRef } from "./workspace-source.ts";
export type { Selection } from "./thread-actions-source.ts";
