import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
  openHistory,
  ProviderHomeSchema,
  type HistoryOptions,
  type HistoryService,
} from "@ace/history-import";
import { ThreadId, AgentId, type ClientMessage, type ServerMessage } from "@ace/protocol";
import { HistoryContinuation, type HistoryAdapterPort } from "./history-continuation.ts";
import { publishHistory } from "./history-publisher.ts";
import type { Store } from "./store.ts";

export type HistoryRequest = Extract<
  ClientMessage,
  { type: "history.scan" | "history.list" | "history.import" | "history.continue" }
>;
export interface DaemonHistoryOptions {
  instances: HistoryOptions["instances"];
  adapters?: HistoryAdapterPort;
  now?: () => number;
  nextId?: () => string;
}
export function readHistoryInstances(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): HistoryOptions["instances"] {
  return z
    .array(ProviderHomeSchema)
    .max(256)
    .parse(
      JSON.parse(
        env.ACE_HISTORY_INSTANCES ??
          JSON.stringify([
            {
              id: "claude-default",
              provider: "claude",
              homeDir: env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
            },
            {
              id: "codex-default",
              provider: "codex",
              homeDir: env.CODEX_HOME ?? join(home, ".codex"),
            },
            {
              id: "opencode-default",
              provider: "opencode",
              homeDir: join(env.XDG_DATA_HOME ?? join(home, ".local/share"), "opencode"),
            },
          ]),
      ),
    );
}
export async function openDaemonHistory(
  dataDir: string,
  store: Store,
  options: DaemonHistoryOptions = { instances: [] },
): Promise<DaemonHistory> {
  const indexPath = join(dataDir, "history/index.sqlite");
  const service = await openHistory({ indexPath, instances: options.instances });
  try {
    await service.scan();
    return new DaemonHistory(store, service, dataDir, indexPath, options);
  } catch (error) {
    await service.close();
    throw error;
  }
}
export class DaemonHistory {
  private store: Store;
  private service: HistoryService;
  private dataDir: string;
  private indexPath: string;
  private now: () => number;
  private nextId: () => string;
  private lifetime = new AbortController();
  private active: Promise<ServerMessage> | undefined;
  private continuation: HistoryContinuation;
  constructor(
    store: Store,
    service: HistoryService,
    dataDir: string,
    indexPath: string,
    options: DaemonHistoryOptions,
  ) {
    this.store = store;
    this.service = service;
    this.dataDir = dataDir;
    this.indexPath = indexPath;
    this.now = options.now ?? Date.now;
    this.nextId = options.nextId ?? randomUUID;
    this.continuation = new HistoryContinuation(
      store,
      service,
      options.adapters,
      this.lifetime.signal,
    );
  }
  async handle(request: HistoryRequest, signal: AbortSignal): Promise<ServerMessage> {
    if (this.active) throw new Error("History operation already in progress");
    const lifetime = AbortSignal.any([signal, this.lifetime.signal]);
    lifetime.throwIfAborted();
    const active = this.run(request, lifetime);
    this.active = active;
    try {
      return await active;
    } finally {
      this.active = undefined;
    }
  }
  private async run(request: HistoryRequest, signal: AbortSignal): Promise<ServerMessage> {
    if (request.type === "history.scan") {
      const scan = await this.service.scan(signal);
      return { type: "history.scan", files: scan.files, unsupported: scan.unsupported };
    }
    if (request.type === "history.list") return this.service.list(request);
    if (request.type === "history.continue") return this.continuation.continue(request, signal);
    const source = await this.service.get(request.sourceId);
    if (!source) throw new Error("Unknown registered history source");
    const workspace = this.store.getWorkspace(request.workspaceId);
    if (!workspace || workspace.path !== source.cwd)
      throw new Error("History workspace does not match source cwd");
    if (source.support.status === "unsupported")
      return { type: "history.import", status: "unsupported", reason: source.support.reason };
    const existing = this.store.importedSource(source.id);
    if (existing) return { type: "history.import", status: "imported", threadId: existing.id };
    let archived = await this.service.findImported(source.id);
    if (!archived) {
      const threadId = ThreadId.parse(this.nextId());
      await this.service.importSession(
        {
          sourceId: source.id,
          threadId,
          workspaceId: request.workspaceId,
          agentId: AgentId.parse(this.nextId()),
          at: this.now(),
        },
        undefined,
        signal,
      );
      archived = await this.service.importedThread(threadId);
    }
    if (!archived || archived.workspaceId !== request.workspaceId)
      throw new Error("Archived workspace does not match request");
    // Stop live callback ingress and drain engine persistence before the worker owns
    // SQLite. No Store write lease is held while awaiting this boundary.
    const resumePersistence = await this.continuation.pausePersistence(signal);
    try {
      signal.throwIfAborted();
      await publishHistory(
        this.store,
        join(this.dataDir, "events.sqlite"),
        this.indexPath,
        archived.id,
        this.now(),
        signal,
      );
    } finally {
      // publishHistory releases its Store lease even on rollback or worker failure.
      await resumePersistence();
    }
    await this.service.deleteImported(archived.id);
    return { type: "history.import", status: "imported", threadId: archived.id };
  }
  async close() {
    this.lifetime.abort();
    await this.active?.catch(() => undefined);
    try {
      await this.continuation.close();
    } finally {
      await this.service.close();
    }
  }
}
