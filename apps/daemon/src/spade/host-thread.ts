import { mkdirSync } from "node:fs";
import {
  ThreadId,
  type AccessMode,
  type AgentId,
  type ProviderKind,
  type WorkspaceId,
} from "@ace/protocol";
import type { HostThreads } from "../engine/host-threads.ts";
import type { ProjectStorage } from "../project-storage.ts";
import type { Store } from "../store.ts";

/** The thread Spade's ace tools act as, and its root agent: what Spade's MCP lease names. */
export interface SpadeHostThread {
  threadId: ThreadId;
  agentId: AgentId;
  workspaceId: WorkspaceId;
}

/** The newest host thread that is still there, with the root agent MCP callers need. */
function findHostThread(store: Store): SpadeHostThread | undefined {
  const row = store
    .statement(
      `SELECT id FROM threads WHERE json_extract(client,'$.host')='spade'
      AND json_extract(client,'$.deletedAt') IS NULL ORDER BY created_at DESC, id LIMIT 1`,
    )
    .get();
  if (!row) return undefined;
  const thread = store.getThread(ThreadId.parse(row.id));
  if (!thread?.rootAgentId || !store.getMcpAgent(thread.id, thread.rootAgentId)) return undefined;
  return { threadId: thread.id, agentId: thread.rootAgentId, workspaceId: thread.workspaceId };
}

/**
 * Spade's host thread (ADR 0117), found or made. It lives in the hidden `spade` project rooted at
 * `folder`; both are made again when missing, so a deleted thread or removed project heals on the
 * next Spade start, and the threads Spade delegated earlier keep their history. Nothing runs in
 * the thread: the engine makes it with no session and refuses to start an agent there.
 */
export function ensureSpadeHostThread(input: {
  store: Store;
  engine: { hosts: Pick<HostThreads, "create" | "setAccess" | "setProvider"> };
  catalog: Pick<ProjectStorage, "registerSpade">;
  folder: string;
  /** The provider a delegation that names none gets, as from any parent thread. */
  provider: ProviderKind;
  /** The person's default access: no child of Spade's runs with more. */
  access: AccessMode;
  id(): string;
}): SpadeHostThread {
  mkdirSync(input.folder, { recursive: true, mode: 0o700 });
  const workspaceId = input.catalog.registerSpade(input.folder);
  const found = findHostThread(input.store);
  if (found) {
    // The person's defaults may have changed since it was made: it always has the current ones.
    input.engine.hosts.setAccess(found.threadId, input.access);
    input.engine.hosts.setProvider(found.threadId, input.provider);
    return found;
  }
  const threadId = ThreadId.parse(input.id());
  const agentId = input.engine.hosts.create({
    id: threadId,
    workspaceId,
    title: "Spade",
    provider: input.provider,
    access: input.access,
    cwd: input.folder,
    host: "spade",
  });
  if (!agentId) throw new Error("Spade's host thread has no root agent");
  return { threadId, agentId, workspaceId };
}
