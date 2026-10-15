import { logFields, logError } from "@ace/diagnostics";
import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertTestHomeIsolation } from "@ace/provider-kit/test-isolation";
import type { HistoryOptions, HistoryRuntime } from "@ace/history-import";
import type { ClientMessage, HistoryOperationProgress, ServerMessage } from "@ace/protocol";
import type { HistoryAdapterPort } from "./history-continuation.ts";
import type { HistoryPublicationWorkerFactory } from "./history-publisher.ts";
import { PastSessions, SESSION_PREFIX, sessionRoot } from "./history-session.ts";
import type { Store } from "./store.ts";

export { readHistoryInstances } from "./history-instances.ts";

export type HistoryRequest = Extract<
  ClientMessage,
  { type: "history.list" | "history.import" | "history.continue" | "history.release" }
>;
export interface DaemonHistoryOptions {
  log?: import("@ace/diagnostics").ComponentLogger;
  onError?(error: unknown, operation: string): void;
  signal?: AbortSignal;
  spawnWorker?: Parameters<typeof import("@ace/history-import").openHistory>[1];
  spawnPublicationWorker?: HistoryPublicationWorkerFactory;
  historyRuntime?: HistoryRuntime;
  instances: HistoryOptions["instances"];
  adapters?: HistoryAdapterPort;
  now?: () => number;
  nextId?: () => string;
  /** Timer for ending a session nobody has used for {@link IDLE_MS}; injected in tests. */
  schedule?: (run: () => void, milliseconds: number) => () => void;
}
/** A session left open by a page that never said goodbye ends after this long. */
export const IDLE_MS = 10 * 60_000;

/**
 * Provider history is read only on request. Nothing happens at startup beyond removing
 * working files a crashed session left behind; the first `history.list` starts a session.
 */
export async function openDaemonHistory(
  dataDir: string,
  store: Store,
  options: DaemonHistoryOptions = { instances: [] },
): Promise<DaemonHistory> {
  options.signal?.throwIfAborted();
  assertTestHomeIsolation(dataDir);
  for (const instance of options.instances) assertTestHomeIsolation(instance.homeDir);
  const root = sessionRoot(dataDir);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  for (const name of names)
    if (name.startsWith(SESSION_PREFIX))
      await rm(join(root, name), { recursive: true, force: true });
  return new DaemonHistory(store, dataDir, options);
}

export class DaemonHistory {
  private store: Store;
  private dataDir: string;
  private options: DaemonHistoryOptions;
  private log: DaemonHistoryOptions["log"];
  private lifetime = new AbortController();
  private session: Promise<PastSessions> | undefined;
  /** Operations run one at a time: a scan, an import and a continuation share the session. */
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private cancelIdle: (() => void) | undefined;
  private schedule: NonNullable<DaemonHistoryOptions["schedule"]>;
  constructor(store: Store, dataDir: string, options: DaemonHistoryOptions) {
    this.store = store;
    this.dataDir = dataDir;
    this.options = options;
    this.log = options.log;
    this.schedule =
      options.schedule ??
      ((run, milliseconds) => {
        const timer = setTimeout(run, milliseconds);
        timer.unref();
        return () => clearTimeout(timer);
      });
  }
  /** Whether a session is open, so tests and diagnostics can see that nothing is held. */
  get open(): boolean {
    return this.session !== undefined;
  }
  handle(
    request: HistoryRequest,
    signal: AbortSignal,
    progress: (event: HistoryOperationProgress) => void = () => {},
  ): Promise<ServerMessage> {
    this.lifetime.signal.throwIfAborted();
    const lifetime = AbortSignal.any([
      signal,
      this.lifetime.signal,
      ...(this.options.signal ? [this.options.signal] : []),
    ]);
    this.pending++;
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    const run = this.queue.then(() => this.run(request, lifetime, progress));
    this.queue = run.catch(() => undefined);
    return run
      .catch((error: unknown) => {
        if (!lifetime.aborted) this.reportError(error, request.type);
        throw error;
      })
      .finally(() => {
        if (--this.pending === 0 && this.session && !this.lifetime.signal.aborted)
          this.cancelIdle = this.schedule(() => void this.release(), IDLE_MS);
      });
  }
  private async run(
    request: HistoryRequest,
    signal: AbortSignal,
    progress: (event: HistoryOperationProgress) => void,
  ): Promise<ServerMessage> {
    signal.throwIfAborted();
    const correlation = request.requestId ? { requestId: request.requestId } : {};
    if (request.type === "history.release") {
      await this.release();
      return { type: "history.release", ...correlation };
    }
    if (request.type === "history.list") return (await this.current()).list(request, signal);
    const session = this.session && (await this.session);
    if (!session)
      return {
        type: request.type,
        ...correlation,
        status: "unsupported",
        reason: "Find past sessions again, then choose the session.",
      };
    const report = (phase: HistoryOperationProgress["phase"], events?: number) => {
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
    try {
      const result =
        request.type === "history.import"
          ? await session.import(request, signal, report)
          : await session.continue(request, signal, report);
      report("status" in result && result.status === "unsupported" ? "unsupported" : "completed");
      return { ...result, ...correlation };
    } catch (error) {
      report("failed");
      throw error;
    }
  }
  private current(): Promise<PastSessions> {
    this.session ??= PastSessions.open(this.store, this.dataDir, {
      instances: this.options.instances,
      spawnWorker: this.options.spawnWorker,
      spawnPublicationWorker: this.options.spawnPublicationWorker,
      historyRuntime: this.options.historyRuntime,
      adapters: this.options.adapters,
      now: this.options.now ?? Date.now,
      nextId: this.options.nextId ?? randomUUID,
    }).catch((error: unknown) => {
      this.session = undefined;
      throw error;
    });
    return this.session;
  }
  /** End the session: its working files are deleted and nothing it read is kept. */
  private async release(): Promise<void> {
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    const session = this.session;
    this.session = undefined;
    if (session) await (await session.catch(() => undefined))?.close();
  }
  private reportError(error: unknown, operation: string): void {
    this.log?.log(
      "warn",
      "Past sessions operation failed",
      logFields([
        ["operation", operation],
        ["error", logError(error)],
      ]),
    );
    this.options.onError?.(error, operation);
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    await this.queue;
    await this.release();
  }
}
