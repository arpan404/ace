import type { ProviderAdapter, ProviderSession, Frame } from "@ace/engine-api";
import type { HistoryService } from "@ace/history-import";
import type { ThreadId, ClientMessage, ServerMessage } from "@ace/protocol";
import { z } from "zod";
import type { Store } from "./store.ts";

const FrameSchema = z.object({
  seq: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  dir: z.enum(["send", "recv", "stderr", "note"]),
  channel: z.string(),
  data: z.unknown(),
});
/** The account owner resolves a home-bound adapter; the engine consumes its live frames. */
export interface HistoryAdapterPort {
  resolve(instanceId: string): ProviderAdapter | undefined;
  onFrame(threadId: ThreadId, instanceId: string, frame: Frame): void;
  onExit(
    threadId: ThreadId,
    instanceId: string,
    exit: { deliberate: boolean; message?: string | undefined },
  ): void;
  fork?(input: { instanceId: string; nativeSessionId: string }): Promise<string>;
  /** Drain current persistence, then pause callback ingress until release. The owner
   * applies bounded transport backpressure, including exit delivery, for all its writers.
   * Release resumes ingress only after the event-store write lease has ended. */
  pausePersistence?(signal: AbortSignal): Promise<() => Promise<void>>;
}
export class HistoryContinuation {
  private sessions = new Map<ThreadId, { session: ProviderSession; instanceId: string }>();
  private port: HistoryAdapterPort | undefined;
  private store: Store;
  private history: HistoryService;
  private lifetime: AbortSignal;
  constructor(
    store: Store,
    history: HistoryService,
    port: HistoryAdapterPort | undefined,
    lifetime: AbortSignal,
  ) {
    this.store = store;
    this.history = history;
    this.port = port;
    this.lifetime = lifetime;
  }
  async continue(
    request: Extract<ClientMessage, { type: "history.continue" }>,
    signal: AbortSignal,
  ): Promise<ServerMessage> {
    const thread = this.store.getThread(request.threadId);
    if (!thread?.imported) throw new Error("Unknown imported thread");
    const source = await this.history.get(thread.imported.sourceId);
    if (!source || source.instanceId !== thread.imported.instanceId)
      throw new Error("History instance is no longer registered");
    const port = this.port,
      adapter = port?.resolve(source.instanceId);
    if (!port || !adapter)
      return {
        type: "history.continue",
        status: "unsupported",
        reason: "A home-bound provider adapter and engine frame consumer are required",
      };
    if (adapter.provider !== source.provider)
      throw new Error("Adapter provider does not match history instance");
    signal.throwIfAborted();
    let active = this.sessions.get(thread.id);
    if (active && request.mode === "fork")
      throw new Error("Close the active continuation before forking");
    if (!active) {
      if (this.sessions.size >= 64) throw new Error("History continuation session limit exceeded");
      const persisted = thread.rootAgentId
        ? this.store.getMcpAgent(thread.id, thread.rootAgentId)
        : undefined;
      const currentNativeId =
        persisted?.native.nativeId ?? thread.imported.native.nativeId ?? source.nativeId;
      // Fork the conversation represented by this thread, including prior continuations.
      // The history service still validates instance/source support and the returned ID.
      const nativeAdapterFork = adapter.forkSession?.bind(adapter);
      const nativeFork =
        port.fork?.bind(port) ??
        (nativeAdapterFork
          ? (input: { instanceId: string; nativeSessionId: string }) =>
              nativeAdapterFork({ nativeSessionId: input.nativeSessionId, signal })
          : undefined);
      const ctx = await this.history.continuation(
        source.id,
        request.mode,
        nativeFork
          ? ({ instanceId }) => nativeFork({ instanceId, nativeSessionId: currentNativeId })
          : undefined,
      );
      signal.throwIfAborted();
      if (request.mode === "fork" && ctx.resume.nativeSessionId === currentNativeId)
        throw new Error("Native history fork reused source identity");
      const resume = request.mode === "resume" ? { nativeSessionId: currentNativeId } : ctx.resume;
      let exited = false;
      const session = await adapter.openSession({
        threadId: thread.id,
        cwd: ctx.cwd,
        ...(ctx.model ? { model: ctx.model } : {}),
        resume,
        signal: this.lifetime,
        onFrame: (frame) => port.onFrame(thread.id, source.instanceId, FrameSchema.parse(frame)),
        onExit: (exit) => {
          exited = true;
          this.sessions.delete(thread.id);
          port.onExit(
            thread.id,
            source.instanceId,
            z.object({ deliberate: z.boolean(), message: z.string().optional() }).parse(exit),
          );
        },
      });
      try {
        signal.throwIfAborted();
        if (exited) throw new Error("History continuation exited during startup");
        z.string().min(1).max(1024).parse(session.nativeSessionId);
        if (thread.rootAgentId)
          this.store.appendEvents(thread.id, [
            {
              type: "agent.updated",
              agentId: thread.rootAgentId,
              native: {
                provider: source.provider,
                nativeId: session.nativeSessionId,
                ...(request.mode === "fork"
                  ? { forkedFromNativeId: currentNativeId }
                  : persisted?.native.forkedFromNativeId
                    ? { forkedFromNativeId: persisted.native.forkedFromNativeId }
                    : {}),
              },
            },
          ]);
      } catch (error) {
        await session.close("shutdown");
        throw error;
      }
      active = { session, instanceId: source.instanceId };
      this.sessions.set(thread.id, active);
    }
    await active.session.send(request.input, request.delivery);
    return {
      type: "history.continue",
      status: "continued",
      threadId: thread.id,
      instanceId: active.instanceId,
      nativeSessionId: active.session.nativeSessionId,
    };
  }
  async pausePersistence(signal: AbortSignal): Promise<() => Promise<void>> {
    signal.throwIfAborted();
    if (this.port?.pausePersistence) return this.port.pausePersistence(signal);
    if (this.sessions.size)
      throw new Error("Active provider persistence must support publication backpressure");
    return async () => {};
  }
  async close() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const closed = await Promise.allSettled(sessions.map((s) => s.session.close("shutdown")));
    for (const result of closed) if (result.status === "rejected") throw result.reason;
  }
}
