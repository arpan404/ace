import { Duration, Effect, Exit, ManagedRuntime, Option, Scope, Stream } from "effect";
import { WS_METHODS } from "@ace/contracts";

import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsClientConnectionIdentity,
  type WsRpcProtocolClient,
} from "./rpc/protocol";
import { reportBackgroundError } from "./lib/async";
import { logLoadDiagnostic } from "./loadDiagnostics";
import { RpcClient } from "effect/unstable/rpc";

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
}

interface RequestOptions {
  readonly timeout?: Option.Option<Duration.Input>;
}

interface WsTransportOptions {
  readonly connectionProbeIntervalMs?: number;
  readonly connectionProbeTimeoutMs?: number;
  readonly clientSessionId?: string;
  readonly disableConnectionProbeLifecycle?: boolean;
}

export interface WsTransportConnectionState {
  readonly kind: "disconnected" | "reconnected";
  readonly error?: string;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = 250;
const DEFAULT_SUBSCRIPTION_RETRY_MULTIPLIER = 2;
const DEFAULT_SUBSCRIPTION_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_CONNECTION_PROBE_INTERVAL_MS = 15_000;
const DEFAULT_CONNECTION_PROBE_TIMEOUT_MS = 4_000;
const DEFAULT_REQUEST_RETRY_LIMIT = 3;
const DEFAULT_REQUEST_RETRY_DELAY_MS = 220;
const WS_CLIENT_SESSION_STORAGE_KEY = "ace.wsClientSessionId";

function resolveRetryDelayMs(retryDelay: Duration.Input | undefined): number {
  const parsedDuration = retryDelay
    ? Duration.fromInput(retryDelay)
    : Option.some(Duration.millis(DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS));
  return Option.match(parsedDuration, {
    onNone: () => DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS,
    onSome: (duration) => {
      const millis = Duration.toMillis(duration);
      if (!Number.isFinite(millis) || millis <= 0) {
        return DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS;
      }
      return millis;
    },
  });
}

function createConnectionId(): string {
  return globalThis.crypto.randomUUID();
}

function resolveClientSessionId(): string {
  const storage = globalThis.window?.sessionStorage;
  const existing = storage?.getItem(WS_CLIENT_SESSION_STORAGE_KEY)?.trim();
  if (existing) {
    return existing;
  }
  const created = createConnectionId();
  storage?.setItem(WS_CLIENT_SESSION_STORAGE_KEY, created);
  return created;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function isRetryableRequestError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes("socketcloseerror") ||
    message.includes("socket closed") ||
    message.includes("websocket") ||
    message.includes("connection closed") ||
    message.includes("1006") ||
    message.includes("econnreset") ||
    message.includes("connection reset")
  );
}

export class WsTransport {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<WsRpcProtocolClient>;
  private readonly identity: WsClientConnectionIdentity;
  private readonly connectionProbeIntervalMs: number;
  private readonly connectionProbeTimeoutMs: number;
  private readonly disableConnectionProbeLifecycle: boolean;
  private readonly connectionStateListeners = new Set<
    (state: WsTransportConnectionState) => void
  >();
  private readonly probeListenerCleanups: Array<() => void> = [];
  private connectionProbeIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly subscriptionRetryWakeListeners = new Set<() => void>();
  private disposed = false;
  private hasConnected = false;
  private disconnected = false;
  private probeInFlight = false;
  private queuedProbe = false;

  constructor(url?: string, options: WsTransportOptions = {}) {
    this.identity = {
      clientSessionId: options.clientSessionId ?? resolveClientSessionId(),
      connectionId: createConnectionId(),
    };
    this.connectionProbeIntervalMs = Math.max(
      0,
      options.connectionProbeIntervalMs ?? DEFAULT_CONNECTION_PROBE_INTERVAL_MS,
    );
    this.connectionProbeTimeoutMs = Math.max(
      1,
      options.connectionProbeTimeoutMs ?? DEFAULT_CONNECTION_PROBE_TIMEOUT_MS,
    );
    this.disableConnectionProbeLifecycle = options.disableConnectionProbeLifecycle ?? false;
    logLoadDiagnostic({
      phase: "ws",
      message: "Creating WebSocket transport",
      detail: {
        clientSessionId: this.identity.clientSessionId,
        connectionId: this.identity.connectionId,
        hasCustomUrl: url !== undefined,
      },
    });
    this.runtime = ManagedRuntime.make(createWsRpcProtocolLayer(url, this.identity));
    this.clientScope = this.runtime.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(
      Scope.provide(this.clientScope)(makeWsRpcProtocolClient),
    );
    this.setupConnectionProbeLifecycle();
  }

  getConnectionIdentity(): WsClientConnectionIdentity {
    return { ...this.identity };
  }

  onConnectionStateChange(listener: (state: WsTransportConnectionState) => void): () => void {
    this.connectionStateListeners.add(listener);
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  private emitConnectionState(state: WsTransportConnectionState): void {
    for (const listener of this.connectionStateListeners) {
      try {
        listener(state);
      } catch {
        // Swallow listener errors so transport teardown remains deterministic.
      }
    }
  }

  private noteConnected(): void {
    if (!this.hasConnected) {
      this.hasConnected = true;
      this.disconnected = false;
      logLoadDiagnostic({
        phase: "ws",
        level: "success",
        message: "WebSocket transport connected",
      });
      return;
    }
    if (!this.disconnected) {
      return;
    }
    this.disconnected = false;
    logLoadDiagnostic({
      phase: "ws",
      level: "success",
      message: "WebSocket transport reconnected",
    });
    this.emitConnectionState({ kind: "reconnected" });
  }

  private noteDisconnected(error: unknown): void {
    if (!this.hasConnected || this.disconnected || this.disposed) {
      return;
    }
    this.disconnected = true;
    logLoadDiagnostic({
      phase: "ws",
      level: "warning",
      message: "WebSocket transport disconnected",
      detail: formatErrorMessage(error),
    });
    this.emitConnectionState({
      kind: "disconnected",
      error: formatErrorMessage(error),
    });
  }

  private setupConnectionProbeLifecycle(): void {
    if (this.disableConnectionProbeLifecycle || typeof window === "undefined") {
      return;
    }

    const queueProbe = (reason: string) => {
      if (reason === "focus" || reason === "online" || reason === "visibilitychange") {
        this.wakeSubscriptionRetries();
      }
      this.queueConnectionProbe(reason);
    };

    if (
      typeof window.addEventListener === "function" &&
      typeof window.removeEventListener === "function"
    ) {
      const onOnline = () => queueProbe("online");
      const onFocus = () => queueProbe("focus");
      window.addEventListener("online", onOnline);
      window.addEventListener("focus", onFocus);
      this.probeListenerCleanups.push(() => {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("focus", onFocus);
      });
    }

    if (
      typeof document !== "undefined" &&
      typeof document.addEventListener === "function" &&
      typeof document.removeEventListener === "function"
    ) {
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          queueProbe("visibilitychange");
        }
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      this.probeListenerCleanups.push(() => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      });
    }

    if (this.connectionProbeIntervalMs > 0) {
      this.connectionProbeIntervalHandle = setInterval(() => {
        if (this.disposed) {
          return;
        }
        if (!this.shouldRunBackgroundConnectionProbe()) {
          return;
        }
        queueProbe("interval");
      }, this.connectionProbeIntervalMs);
    }
  }

  private shouldRunBackgroundConnectionProbe(): boolean {
    if (typeof document === "undefined") {
      return true;
    }
    if (document.visibilityState === "hidden") {
      return false;
    }
    if (typeof document.hasFocus === "function" && !document.hasFocus()) {
      return false;
    }
    return true;
  }

  private wakeSubscriptionRetries(): void {
    for (const listener of this.subscriptionRetryWakeListeners) {
      listener();
    }
  }

  private waitForSubscriptionRetryDelay(delayMs: number): Promise<void> {
    if (delayMs <= 0 || this.disposed) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        this.subscriptionRetryWakeListeners.delete(settle);
        resolve();
      };

      timeoutHandle = setTimeout(settle, delayMs);
      this.subscriptionRetryWakeListeners.add(settle);
    });
  }

  private queueConnectionProbe(reason: string): void {
    if (this.disposed) {
      return;
    }
    if (this.probeInFlight) {
      this.queuedProbe = true;
      return;
    }
    this.probeInFlight = true;
    void this.runConnectionProbe(reason).finally(() => {
      this.probeInFlight = false;
      if (this.disposed || !this.queuedProbe) {
        return;
      }
      this.queuedProbe = false;
      this.queueConnectionProbe("queued");
    });
  }

  private async runConnectionProbe(reason: string): Promise<void> {
    try {
      const client = await this.clientPromise;
      const probeResult = await this.runtime.runPromise(
        Effect.suspend(() => client[WS_METHODS.serverGetConfig]({})).pipe(
          Effect.timeoutOption(Duration.millis(this.connectionProbeTimeoutMs)),
        ),
      );
      if (Option.isNone(probeResult)) {
        throw new Error(
          `WebSocket probe timed out after ${String(this.connectionProbeTimeoutMs)}ms (${reason})`,
        );
      }
      this.noteConnected();
    } catch (error) {
      this.noteDisconnected(error);
    }
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    _options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    let attempt = 0;
    let lastError: unknown;

    while (!this.disposed) {
      try {
        const client = await this.clientPromise;
        const result = await this.runtime.runPromise(Effect.suspend(() => execute(client)));
        if (this.disposed) {
          throw new Error("Transport disposed");
        }
        this.noteConnected();
        return result;
      } catch (error) {
        if (this.disposed) {
          throw new Error("Transport disposed", { cause: error });
        }
        this.noteDisconnected(error);
        lastError = error;
        if (!isRetryableRequestError(error) || attempt >= DEFAULT_REQUEST_RETRY_LIMIT) {
          throw error;
        }
        attempt += 1;
        const delayMs = DEFAULT_REQUEST_RETRY_DELAY_MS * attempt;
        logLoadDiagnostic({
          phase: "ws",
          level: "warning",
          message: "Retrying WebSocket request after transient disconnect",
          detail: {
            attempt,
            delayMs,
            error: formatErrorMessage(error),
          },
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Transport disposed");
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const client = await this.clientPromise;
    try {
      await this.runtime.runPromise(
        Stream.runForEach(connect(client), (value) =>
          Effect.sync(() => {
            if (this.disposed) {
              return;
            }
            try {
              listener(value);
            } catch {
              // Swallow listener errors so the stream can finish cleanly.
            }
          }),
        ),
      );
      if (this.disposed) {
        throw new Error("Transport disposed");
      }
      this.noteConnected();
    } catch (error) {
      if (this.disposed) {
        throw new Error("Transport disposed", { cause: error });
      }
      this.noteDisconnected(error);
      throw error;
    }
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    let retryCount = 0;
    let sawValueSinceRetry = false;
    const baseRetryDelayMs = resolveRetryDelayMs(options?.retryDelay);
    const maxRetryDelayMs = Math.max(baseRetryDelayMs, DEFAULT_SUBSCRIPTION_MAX_RETRY_DELAY_MS);
    const cancel = this.runtime.runCallback(
      Effect.promise(() => this.clientPromise).pipe(
        Effect.flatMap((client) =>
          Effect.sync(() => {
            sawValueSinceRetry = false;
            this.noteConnected();
          }).pipe(
            Effect.andThen(
              Stream.runForEach(connect(client), (value) =>
                Effect.sync(() => {
                  if (!active) {
                    return;
                  }
                  sawValueSinceRetry = true;
                  try {
                    listener(value);
                  } catch {
                    // Swallow listener errors so the stream stays live.
                  }
                }),
              ),
            ),
            Effect.tap(() =>
              active && !this.disposed
                ? Effect.sync(() => {
                    this.noteDisconnected(new Error("Subscription ended"));
                  })
                : Effect.void,
            ),
          ),
        ),
        Effect.catch((error) => {
          if (!active || this.disposed) {
            return Effect.interrupt;
          }
          if (sawValueSinceRetry) {
            retryCount = 0;
          }
          retryCount++;
          const delayMs = Math.min(
            baseRetryDelayMs * Math.pow(DEFAULT_SUBSCRIPTION_RETRY_MULTIPLIER, retryCount - 1),
            maxRetryDelayMs,
          );
          this.noteDisconnected(error);
          return Effect.sync(() => {
            console.warn("WebSocket RPC subscription disconnected, retrying", {
              error: formatErrorMessage(error),
              retryCount,
              delayMs,
            });
          }).pipe(
            Effect.andThen(Effect.promise(() => this.waitForSubscriptionRetryDelay(delayMs))),
          );
        }),
        Effect.forever,
      ),
    );

    return () => {
      active = false;
      cancel();
    };
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.queuedProbe = false;
    if (typeof this.wakeSubscriptionRetries === "function") {
      this.wakeSubscriptionRetries();
    }
    if (this.connectionProbeIntervalHandle !== null) {
      clearInterval(this.connectionProbeIntervalHandle);
      this.connectionProbeIntervalHandle = null;
    }
    for (const cleanup of this.probeListenerCleanups.splice(0)) {
      cleanup();
    }
    const clientPromise = Reflect.get(this, "clientPromise") as
      | Promise<WsRpcProtocolClient>
      | undefined;
    const client =
      clientPromise && this.hasConnected
        ? await Promise.race([
            clientPromise.catch((error) => {
              reportBackgroundError(
                "Failed to resolve the WebSocket RPC client during transport disposal.",
                error,
              );
              return undefined;
            }),
            new Promise<undefined>((resolve) => setTimeout(resolve, 50)),
          ])
        : undefined;
    if (client && this.hasConnected) {
      await Promise.race([
        this.runtime
          .runPromise(
            Effect.suspend(() =>
              client[WS_METHODS.serverDisconnect]({
                clientSessionId: this.identity.clientSessionId,
                connectionId: this.identity.connectionId,
              }),
            ),
          )
          .catch((error) => {
            if (
              isRetryableRequestError(error) ||
              formatErrorMessage(error).toLowerCase().includes("all fibers interrupted")
            ) {
              return;
            }
            reportBackgroundError(
              "Failed to send the server disconnect event before transport disposal.",
              error,
            );
          }),
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
    }
    await this.runtime.runPromise(Scope.close(this.clientScope, Exit.void)).finally(() => {
      this.runtime.dispose();
    });
  }
}
