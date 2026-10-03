import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { fakeCommandSource, type CommandSource } from "./command-source.ts";
import { fakeContextSource, type ContextSource } from "./context-source.ts";
import { fakeModelSource, type ModelSource } from "./model-source.ts";
import { fakeThreadActionsSource, type ThreadActionsSource } from "./thread-actions-source.ts";
import { fakeWorkspaceSource, type WorkspaceSource } from "./workspace-source.ts";

/**
 * Everything the thread screen reads or does that the daemon protocol on main cannot carry yet.
 * Components depend on these interfaces only; each source file holds its own fake.
 */
export interface ThreadSources {
  workspace: WorkspaceSource;
  context: ContextSource;
  models: ModelSource;
  commands: CommandSource;
  actions: ThreadActionsSource;
}

// TODO(train-2): wire to protocol when merged. Replace the fakes with daemon-backed sources
// built from `client`; nothing else changes.
function createSources(_client: ClientApi): ThreadSources {
  return {
    workspace: fakeWorkspaceSource(),
    context: fakeContextSource(),
    models: fakeModelSource(),
    commands: fakeCommandSource(),
    actions: fakeThreadActionsSource(),
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
