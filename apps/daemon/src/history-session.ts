import { join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
  openHistory,
  type HistoryOptions,
  type HistoryRuntime,
  type HistoryService,
} from "@ace/history-import";
import type { HistoryScanStatus } from "@ace/protocol/history";
import { ThreadId, AgentId, type ClientMessage, type ServerMessage } from "@ace/protocol";
import { HistoryContinuation, type HistoryAdapterPort } from "./history-continuation.ts";
import { publishHistory, type HistoryPublicationWorkerFactory } from "./history-publisher.ts";
import type { Store } from "./store.ts";

/** Where on-demand sessions keep their working files; removed when each session ends. */
export const SESSION_PREFIX = "past-sessions-";
export function sessionRoot(dataDir: string): string {
  return join(dataDir, "tmp");
}

export interface PastSessionsOptions {
  instances: HistoryOptions["instances"];
  spawnWorker?: Parameters<typeof openHistory>[1] | undefined;
  spawnPublicationWorker?: HistoryPublicationWorkerFactory | undefined;
  historyRuntime?: HistoryRuntime | undefined;
  adapters?: HistoryAdapterPort | undefined;
  now: () => number;
  nextId: () => string;
}
type Report = (
  phase: import("@ace/protocol").HistoryOperationProgress["phase"],
  events?: number,
) => void;

/**
 * One look through provider history, started by an explicit request and ended by release,
 * idleness or shutdown. Its index lives in a private working directory that is deleted when
 * the session ends; nothing it read outlives it except a session the person imports.
 */
export class PastSessions {
  private store: Store;
  private dataDir: string;
  private dir: string;
  private service: HistoryService;
  private continuation: HistoryContinuation;
  private options: PastSessionsOptions;
  private lifetime = new AbortController();
  private scanned: HistoryScanStatus | undefined;
  private constructor(
    store: Store,
    dataDir: string,
    dir: string,
    service: HistoryService,
    options: PastSessionsOptions,
  ) {
    this.store = store;
    this.dataDir = dataDir;
    this.dir = dir;
    this.service = service;
    this.options = options;
    this.continuation = new HistoryContinuation(
      store,
      service,
      options.adapters,
      this.lifetime.signal,
    );
  }
  static async open(store: Store, dataDir: string, options: PastSessionsOptions) {
    const root = sessionRoot(dataDir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(root, SESSION_PREFIX));
    try {
      const service = await openHistory(
        { indexPath: join(dir, "index.sqlite"), instances: options.instances },
        options.spawnWorker,
        options.historyRuntime,
      );
      return new PastSessions(store, dataDir, dir, service, options);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  async list(
    request: Extract<ClientMessage, { type: "history.list" }>,
    signal: AbortSignal,
  ): Promise<ServerMessage> {
    if (!this.scanned || request.rescan) {
      const result = await this.service.scan(signal);
      this.scanned = {
        state: "ready",
        stats: {
          files: result.files,
          reads: result.reads,
          bytes: result.bytes,
          skipped: result.skipped,
        },
        unsupported: result.unsupported,
      };
    }
    const page = await this.service.list(request, this.store.nativeSessionKeys());
    return {
      ...page,
      sessions: page.sessions.map((session) => {
        session.continuation = this.continuation.support(session.instanceId);
        return session;
      }),
      requestId: request.requestId,
      scan: this.scanned,
    };
  }
  continue(
    request: Extract<ClientMessage, { type: "history.continue" }>,
    signal: AbortSignal,
    report: Report,
  ): Promise<ServerMessage> {
    return this.continuation.continue(request, signal, report);
  }
  async import(
    request: Extract<ClientMessage, { type: "history.import" }>,
    signal: AbortSignal,
    report: Report,
  ): Promise<ServerMessage> {
    const source = await this.service.get(request.sourceId);
    if (!source) throw new Error("Unknown history source");
    const workspace = this.store.getWorkspace(request.workspaceId);
    if (!workspace || workspace.path !== source.cwd)
      throw new Error("History workspace does not match source cwd");
    if (source.support.status === "unsupported")
      return { type: "history.import", status: "unsupported", reason: source.support.reason };
    const existing = this.store.importedSource(source.id);
    if (existing) {
      // A publication that committed but lost its reply still owes subscribers its events.
      const resumePersistence = await this.continuation.pausePersistence(signal);
      try {
        signal.throwIfAborted();
        await this.store.startHistoryWriting(signal);
        try {
          await this.store.notifyHistory();
        } finally {
          this.store.setHistoryWriting(false);
        }
      } finally {
        await resumePersistence();
      }
      await this.service.deleteImported(existing.id);
      return { type: "history.import", status: "imported", threadId: existing.id };
    }
    // An archive staged earlier in this session, whose publication failed, is reused.
    let archived = await this.service.findImported(source.id);
    if (!archived) {
      const threadId = ThreadId.parse(this.options.nextId());
      report("reading");
      await this.service.importSession(
        {
          sourceId: source.id,
          threadId,
          workspaceId: request.workspaceId,
          agentId: AgentId.parse(this.options.nextId()),
          at: this.options.now(),
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
      report("publishing");
      await publishHistory(
        this.store,
        join(this.dataDir, "events.sqlite"),
        join(this.dir, "index.sqlite"),
        archived.id,
        this.options.now(),
        signal,
        this.options.spawnPublicationWorker,
      );
    } finally {
      // publishHistory releases its Store lease even on rollback or worker failure.
      await resumePersistence();
    }
    await this.service.deleteImported(archived.id);
    return { type: "history.import", status: "imported", threadId: archived.id };
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    try {
      await this.continuation.close();
    } finally {
      try {
        await this.service.close();
      } finally {
        await rm(this.dir, { recursive: true, force: true });
      }
    }
  }
}
