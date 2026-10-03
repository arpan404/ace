import { acpInjection } from "@ace/mcp-server";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { ShellSettlement } from "./shell-settlement.ts";
import { cancellationGraceMs, promptStop } from "./settlement.ts";
import type { ProviderSession, SessionContext } from "@ace/engine-api";
import { encodeContent } from "./content.ts";
import type { ContentPart, InteractionResolution } from "@ace/protocol";
import { JsonRpcPeer, MethodNotFound, type ServerRequest } from "@ace/provider-kit/jsonrpc";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { object, string } from "./data.ts";
import {
  encodeResolution,
  interactionKey,
  interactionRequest,
  validateResolution,
} from "./interactions.ts";
import type { AcpQuirks } from "./quirks/types.ts";
import { SessionRouting } from "./session-routing.ts";
import { nativeAgentKey } from "./keys.ts";
interface PendingInteraction {
  request: ServerRequest;
  owner: string;
  answer(value: unknown): void;
}
interface Queued {
  input: ContentPart[];
  resolve(): void;
  reject(error: unknown): void;
}
export interface LaunchOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}
export interface SessionRuntime {
  spawn: typeof spawnSupervised;
  now(): number;
  schedule?(delay: number, run: () => void): () => void;
}
export async function openAcpSession(
  ctx: SessionContext,
  quirks: AcpQuirks,
  launch: LaunchOptions,
  runtime: SessionRuntime = { spawn: spawnSupervised, now: () => performance.now() },
): Promise<ProviderSession> {
  if (ctx.signal.aborted) throw new Error("ACP session lifetime already ended");
  const proc = runtime.spawn({
    command: launch.command,
    args: launch.args,
    cwd: ctx.cwd,
    env: launch.env ?? {},
    name: quirks.provider,
  });
  const session = new AcpSession(ctx, quirks, proc, runtime);
  try {
    await session.initialize();
    return session;
  } catch (error) {
    await session.close("shutdown");
    throw error;
  }
}
class AcpSession implements ProviderSession {
  nativeSessionId = "";
  readonly ctx: SessionContext;
  readonly quirks: AcpQuirks;
  readonly proc: SupervisedProcess;
  readonly rpc: JsonRpcPeer;
  readonly pending = new Map<string, PendingInteraction>();
  readonly routing: SessionRouting;
  readonly shells: ShellSettlement;
  readonly schedule: (delay: number, run: () => void) => () => void;
  cancelGrace?: () => void;
  fault?: Error;
  readonly queue: Queued[] = [];
  active = false;
  closed = false;
  deliberate = false;
  sequence = 0;
  readonly started: number;
  readonly now: () => number;
  constructor(
    ctx: SessionContext,
    quirks: AcpQuirks,
    proc: SupervisedProcess,
    runtime: SessionRuntime,
  ) {
    this.now = runtime.now;
    this.started = runtime.now();
    this.shells = new ShellSettlement(quirks);
    this.routing = new SessionRouting(ctx.threadId, ctx.resume?.nativeSessionId ?? "");
    this.schedule =
      runtime.schedule ??
      ((delay, run) => {
        const timer = setTimeout(run, delay);
        return () => clearTimeout(timer);
      });
    this.ctx = ctx;
    this.quirks = quirks;
    this.proc = proc;
    this.rpc = new JsonRpcPeer(proc, {
      onFrame: (dir, data) => this.frame(dir, "stdio", data),
      onMalformed: (line) => this.frame("recv", "stdio-text", line),
      onError: (error) =>
        this.frame("note", "transport", { event: "transport-error", message: error.message }),
    });
    this.rpc.onRequest = (request) => this.handleRequest(request);
    this.rpc.onNotification = (notification) => {
      if (notification.method !== "session/update") return;
      this.routing.receive(object(notification.params));
      this.shells.receive(object(notification.params));
      if (!this.routing.hasLiveChildren) this.clearGrace();
      void this.drain();
    };
    proc.stdout.once("close", this.stdoutClosed);
    proc.stderr.on("line", (line) => this.frame("stderr", "stdio", line));
    ctx.signal.addEventListener("abort", this.abort, { once: true });
    void proc.exited.then((exit) => {
      this.closed = true;
      this.clearGrace();
      ctx.signal.removeEventListener("abort", this.abort);
      this.cancelQuestions();
      this.rejectQueue(new Error("ACP process exited"));
      this.frame("note", "recorder", {
        event: "process-exit",
        detail: { ...exit, deliberate: this.deliberate },
      });
      ctx.onExit({
        deliberate: this.deliberate,
        message: `ACP process exited: ${exit.code ?? exit.signal ?? exit.reason}`,
      });
    });
    this.frame("note", "recorder", { event: "process-start" });
    if (ctx.signal.aborted) this.abort();
  }
  clearGrace(): void {
    this.cancelGrace?.();
    delete this.cancelGrace;
  }
  stdoutClosed = (): void => {
    if (!this.closed && !this.proc.signal.aborted)
      this.fail(new Error("ACP transport stdout closed before process termination"));
  };
  fail(error: Error): void {
    if (this.closed) return;
    this.fault = error;
    this.closed = true;
    this.clearGrace();
    this.frame("note", "transport", { event: "transport-error", message: error.message });
    this.cancelQuestions();
    this.rejectQueue(error);
    this.rpc.close(error);
    void this.proc.stop();
  }
  abort = (): void => {
    void this.close("shutdown");
  };
  frame(dir: "send" | "recv" | "stderr" | "note", channel: string, data: unknown): void {
    const payload = new ProviderPayload(
      this.ctx.aceMcp
        ? JSON.stringify(data).replaceAll(this.ctx.aceMcp.bearer, "[ace credential redacted]")
        : JSON.stringify(data),
    );
    this.ctx.onFrame({
      seq: this.sequence++,
      t: Math.round(this.now() - this.started),
      dir,
      channel,
      data: payload.data,
      payload,
    });
  }
  async initialize(): Promise<void> {
    const result = object(
      await this.rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "ace", version: "0.0.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            _meta: this.quirks.clientMeta,
          },
        },
        { signal: this.ctx.signal },
      ),
    );
    if (result["protocolVersion"] !== 1) throw new Error("ACP protocol version 1 is required");
    if (
      this.quirks.provider === "antigravity" &&
      object(result["agentInfo"])["name"] !== "antigravity-acp"
    )
      throw new Error("Unexpected Antigravity ACP server identity");
    this.rpc.notify("initialized");
    const resume = this.ctx.resume;
    const session = object(
      await this.rpc.request(
        resume ? "session/load" : "session/new",
        {
          cwd: this.ctx.cwd,
          mcpServers:
            this.ctx.aceMcp &&
            object(object(result["agentCapabilities"])["mcpCapabilities"])["http"] === true
              ? acpInjection(
                  this.ctx.aceMcp,
                  this.quirks.provider === "cursor" || this.quirks.provider === "antigravity"
                    ? this.quirks.provider
                    : "acp",
                ).mcpServers
              : [],
          ...(resume ? { sessionId: resume.nativeSessionId } : {}),
        },
        { signal: this.ctx.signal },
      ),
    );
    this.nativeSessionId = string(session["sessionId"]) || resume?.nativeSessionId || "";
    this.routing.bindRoot(this.nativeSessionId);
    if (!this.nativeSessionId) throw new Error("ACP server did not return a session id");
    if (this.ctx.model)
      await this.rpc.request(
        "session/set_config_option",
        { sessionId: this.nativeSessionId, configId: "model", value: this.ctx.model },
        { signal: this.ctx.signal },
      );
  }
  async send(input: ContentPart[], _delivery: "steer" | "queue"): Promise<void> {
    if (this.closed) throw new Error("ACP session closed");
    if (this.shells.blocked) throw new Error("ACP shell execution completion is unconfirmed");
    await new Promise<void>((resolve, reject) => {
      this.queue.push({ input: structuredClone(input), resolve, reject });
      this.queueChanged();
      void this.drain();
    });
  }
  queueChanged(): void {
    this.frame("note", "recorder", { event: "queue-changed", count: this.queue.length });
  }
  async drain(): Promise<void> {
    if (this.active || this.closed || this.routing.hasLiveChildren) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = true;
    this.queueChanged();
    try {
      const result = await this.rpc.request(
        "session/prompt",
        { sessionId: this.nativeSessionId, prompt: next.input.map(encodeContent) },
        { timeoutMs: null, signal: this.ctx.signal },
      );
      const stop = promptStop(result);
      if (!stop) {
        const error = new Error("ACP prompt completion is unconfirmed");
        this.fail(error);
        throw error;
      }
      this.shells.promptEnded(this.nativeSessionId, stop);
      if (this.shells.blocked)
        this.rejectQueue(new Error("ACP shell execution completion is unconfirmed"));
      if (stop === "cancelled" && this.routing.hasLiveChildren) {
        this.clearGrace();
        this.cancelGrace = this.schedule(cancellationGraceMs, () => {
          if (this.routing.hasLiveChildren)
            this.fail(new Error("ACP child cancellation completion is unconfirmed after grace"));
        });
      }
      next.resolve();
    } catch (error) {
      next.reject(error);
    } finally {
      this.active = false;
      void this.drain();
    }
  }
  handleRequest(request: ServerRequest): unknown | Promise<unknown> {
    const params = object(request.params);
    if (
      ["cursor/task", "cursor/update_todos", "cursor/generate_image"].includes(request.method) &&
      this.quirks.provider === "cursor"
    )
      return {};
    if (!interactionRequest(request.method, params, this.quirks.provider === "antigravity"))
      throw new MethodNotFound();
    if (this.closed) return { outcome: { outcome: "cancelled" } };
    if (this.pending.has(interactionKey(request.id)))
      throw new Error("Duplicate pending ACP request");
    return new Promise((resolve) =>
      this.pending.set(interactionKey(request.id), {
        request,
        owner: this.routing.owner(params, this.nativeSessionId),
        answer: resolve,
      }),
    );
  }
  async resolve(key: string, resolution: InteractionResolution): Promise<void> {
    const pending = this.pending.get(key);
    if (!pending) throw new Error("ACP interaction is no longer pending");
    const request = interactionRequest(
      pending.request.method,
      object(pending.request.params),
      this.quirks.provider === "antigravity",
    );
    if (!request) throw new Error("Interaction request is no longer valid");
    const validated = validateResolution(request, resolution);
    const answer = encodeResolution(pending.request.method, validated, request);
    this.pending.delete(key);
    pending.answer(answer);
  }
  cancelQuestions(owners?: Set<string>): void {
    for (const [key, pending] of this.pending)
      if (!owners || owners.has(pending.owner)) {
        pending.answer({ outcome: { outcome: "cancelled" } });
        this.pending.delete(key);
      }
  }
  async interrupt(target: { agent?: string; cascade: boolean }): Promise<void> {
    if (this.closed) throw new Error("ACP session closed");
    const child = target.agent ? this.routing.byKey.get(target.agent) : undefined;
    if (
      target.agent &&
      !child &&
      target.agent !== "root" &&
      target.agent !== nativeAgentKey(this.ctx.threadId, this.nativeSessionId)
    )
      throw new Error("Unknown ACP agent key");
    if (child && !child.cancel) throw new Error("ACP child does not permit cancellation");
    const id = child?.id ?? this.nativeSessionId;
    const descendants = target.cascade ? this.routing.descendants(id) : [];
    this.cancelQuestions(new Set([id, ...descendants.map((value) => value.id)]));
    this.rpc.notify("session/cancel", { sessionId: id });
    for (const descendant of descendants)
      if (descendant.live && descendant.cancel)
        this.rpc.notify("session/cancel", { sessionId: descendant.id });
  }
  async stopTask(_task: string): Promise<void> {
    throw new Error("ACP does not expose individual background task control");
  }
  async close(_reason: "idle" | "user" | "shutdown"): Promise<void> {
    if (!this.proc.signal.aborted && !this.fault) this.deliberate = true;
    if (!this.closed) {
      this.closed = true;
      this.clearGrace();
      this.proc.stdout.removeListener("close", this.stdoutClosed);
      this.frame("note", "recorder", { event: "stop" });
      this.cancelQuestions();
      this.rejectQueue(new Error("ACP session closed"));
      this.rpc.close();
      this.ctx.signal.removeEventListener("abort", this.abort);
    }
    await this.proc.stop();
  }
  rejectQueue(error: Error): void {
    for (const job of this.queue.splice(0)) job.reject(error);
    this.queueChanged();
  }
}
