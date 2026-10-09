import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { assertTestHomeIsolation } from "@ace/provider-kit/test-isolation";
import {
  openHistory,
  ProviderHomeSchema,
  type HistoryOptions,
  type HistoryService,
  type HistoryRuntime,
} from "@ace/history-import";
import { HistoryScanStatus } from "@ace/protocol/history";
import { ThreadId, AgentId, type ClientMessage, type ServerMessage } from "@ace/protocol";
import { HistoryContinuation, type HistoryAdapterPort } from "./history-continuation.ts";
import { publishHistory } from "./history-publisher.ts";
import type { Store } from "./store.ts";

export type HistoryRequest = Extract<
  ClientMessage,
  { type: "history.scan" | "history.list" | "history.import" | "history.continue" }
>;
export interface DaemonHistoryOptions {
  onError?(error: unknown, operation: string): void;
  signal?: AbortSignal;
  spawnWorker?: Parameters<typeof openHistory>[1];
  historyRuntime?: HistoryRuntime;
  scheduleScan?: (run: () => void, milliseconds: number) => () => void;
  instances: HistoryOptions["instances"];
  adapters?: HistoryAdapterPort;
  now?: () => number;
  nextId?: () => string;
}
export function readHistoryInstances(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): HistoryOptions["instances"] {
  const instances = z
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
  for (const instance of instances) assertTestHomeIsolation(instance.homeDir);
  return instances;
}
export async function openDaemonHistory(
  dataDir: string,
  store: Store,
  options: DaemonHistoryOptions = { instances: [] },
): Promise<DaemonHistory> {
  options.signal?.throwIfAborted();
  assertTestHomeIsolation(dataDir);
  for (const instance of options.instances) assertTestHomeIsolation(instance.homeDir);
  const indexPath = join(dataDir, "history/index.sqlite");
  const service = await openHistory(
    { indexPath, instances: options.instances },
    options.spawnWorker,
    options.historyRuntime,
  );
  try {
    options.signal?.throwIfAborted();
    const history = new DaemonHistory(store, service, dataDir, indexPath, options);
    history.startScan();
    return history;
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
  private onError: DaemonHistoryOptions["onError"];
  private nextId: () => string;
  private lifetime = new AbortController();
  private externalSignal: AbortSignal | undefined;
  private active: Promise<ServerMessage> | undefined;
  private continuation: HistoryContinuation;
  private scanController: AbortController | undefined;
  private scanning: Promise<void> | undefined;
  private changesQueued = false;
  private changeScan: (() => void) | undefined;
  private nextChangeScanAt = 0;
  private scheduleScan: NonNullable<DaemonHistoryOptions["scheduleScan"]>;
  private unsubscribeChanges: () => void;
  private scanState: HistoryScanStatus = {
    state: "idle",
    stats: { files: 0, reads: 0, bytes: 0, skipped: 0 },
    unsupported: [],
  };
  private listeners = new Set<(status: HistoryScanStatus) => void>();
  scanStatus(): HistoryScanStatus {
    return HistoryScanStatus.parse(this.scanState);
  }
  subscribeScan(listener: (status: HistoryScanStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publishScan(status: HistoryScanStatus): void {
    this.scanState = HistoryScanStatus.parse(status);
    for (const listener of this.listeners) listener(this.scanStatus());
  }
  startScan(): Promise<void> {
    return this.runScan((signal, progress) => this.service.scan(signal, progress));
  }
  private scheduleChanges(): void {
    this.changesQueued = true;
    if (this.changeScan || this.scanning || this.active || this.lifetime.signal.aborted) return;
    this.changeScan = this.scheduleScan(
      () => {
        this.changeScan = undefined;
        if (this.scanning || this.active || this.lifetime.signal.aborted) return;
        this.changesQueued = false;
        this.nextChangeScanAt = this.now() + 5000;
        void this.runScan((signal, progress) => this.service.scanChanges(signal, progress));
      },
      Math.max(1000, this.nextChangeScanAt - this.now()),
    );
  }
  private runScan(scan: HistoryService["scan"]): Promise<void> {
    if (this.scanning) return this.scanning;
    this.lifetime.signal.throwIfAborted();
    if (this.active) throw new Error("History import or continuation in progress");
    const controller = new AbortController();
    this.scanController = controller;
    const signal = AbortSignal.any([
      controller.signal,
      this.lifetime.signal,
      ...(this.externalSignal ? [this.externalSignal] : []),
    ]);
    this.publishScan({
      state: "scanning",
      stats: { files: 0, reads: 0, bytes: 0, skipped: 0 },
      unsupported: [],
    });
    this.scanning = scan(signal, (_files, result) => {
      this.publishScan({ state: "scanning", stats: result, unsupported: result.unsupported });
    })
      .then(
        (result) => {
          this.publishScan({ state: "ready", stats: result, unsupported: result.unsupported });
        },
        (error: unknown) => {
          if (!signal.aborted) this.onError?.(error, "history.scan");
          this.publishScan({
            ...this.scanState,
            state: signal.aborted ? "idle" : "failed",
            ...(signal.aborted
              ? {}
              : {
                  error:
                    error instanceof Error ? error.message.slice(0, 8192) : "History scan failed",
                }),
          });
        },
      )
      .finally(() => {
        this.scanning = undefined;
        this.scanController = undefined;
        if (this.changesQueued) this.scheduleChanges();
      });
    return this.scanning;
  }
  private async stopScan(): Promise<void> {
    this.scanController?.abort();
    await this.scanning;
  }
  constructor(
    store: Store,
    service: HistoryService,
    dataDir: string,
    indexPath: string,
    options: DaemonHistoryOptions,
  ) {
    this.onError = options.onError;
    this.externalSignal = options.signal;
    this.store = store;
    this.service = service;
    this.dataDir = dataDir;
    this.indexPath = indexPath;
    this.now = options.now ?? Date.now;
    this.scheduleScan =
      options.scheduleScan ??
      ((run, milliseconds) => {
        const timer = setTimeout(run, milliseconds);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.nextId = options.nextId ?? randomUUID;
    this.unsubscribeChanges = service.subscribeChanges(() => this.scheduleChanges());
    this.continuation = new HistoryContinuation(
      store,
      service,
      options.adapters,
      this.lifetime.signal,
    );
  }
  async handle(
    request: HistoryRequest,
    signal: AbortSignal,
    progress: (event: import("@ace/protocol").HistoryOperationProgress) => void = () => {},
  ): Promise<ServerMessage> {
    try {
      return await this.handleRequest(request, signal, progress);
    } catch (error) {
      if (!signal.aborted) this.onError?.(error, request.type);
      throw error;
    }
  }
  private async handleRequest(
    request: HistoryRequest,
    signal: AbortSignal,
    progress: (event: import("@ace/protocol").HistoryOperationProgress) => void = () => {},
  ): Promise<ServerMessage> {
    signal.throwIfAborted();
    this.externalSignal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (request.type === "history.scan") {
      if (request.action !== "status") this.startScan();
      const scan = this.scanStatus();
      return {
        type: "history.scan",
        requestId: request.requestId,
        scan,
        files: scan.stats.files,
        unsupported: scan.unsupported,
      };
    }
    if (request.type === "history.list") {
      const page = await this.service.list(request);
      return {
        ...page,
        sessions: page.sessions.map((session) => {
          session.continuation = this.continuation.support(session.instanceId);
          return session;
        }),
        requestId: request.requestId,
        scan: this.scanStatus(),
      };
    }
    if (this.active) throw new Error("History operation already in progress");
    const lifetime = AbortSignal.any([
      signal,
      this.lifetime.signal,
      ...(this.externalSignal ? [this.externalSignal] : []),
    ]);
    lifetime.throwIfAborted();
    const report = (
      phase: import("@ace/protocol").HistoryOperationProgress["phase"],
      events?: number,
    ) => {
      if (request.requestId)
        progress({
          type: "history.operation.progress",
          requestId: request.requestId,
          operation: request.type,
          phase,
          ...(events === undefined ? {} : { events }),
        });
    };
    report("preparing");
    const active = this.stopScan().then(() => this.run(request, lifetime, report));
    this.active = active;
    try {
      const result = await active;
      report("status" in result && result.status === "unsupported" ? "unsupported" : "completed");
      if (result.type !== "history.import" && result.type !== "history.continue")
        throw new Error("Invalid history reply");
      return request.requestId ? { ...result, requestId: request.requestId } : result;
    } catch (error) {
      report("failed");
      throw error;
    } finally {
      this.active = undefined;
      if (this.changesQueued) this.scheduleChanges();
    }
  }
  private async run(
    request: HistoryRequest,
    signal: AbortSignal,
    report: (
      phase: import("@ace/protocol").HistoryOperationProgress["phase"],
      events?: number,
    ) => void,
  ): Promise<ServerMessage> {
    if (request.type === "history.continue")
      return this.continuation.continue(request, signal, report);
    if (request.type !== "history.import") throw new Error("Unexpected history operation");
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
      report("reading");
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
      report("publishing");
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
    this.unsubscribeChanges();
    this.changeScan?.();
    this.lifetime.abort();
    await this.stopScan();
    this.listeners.clear();
    await this.active?.catch(() => undefined);
    try {
      await this.continuation.close();
    } finally {
      await this.service.close();
    }
  }
}
