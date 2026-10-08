import { nativeCommandInputs } from "@ace/commands/invocation";
import { SessionOpenError } from "@ace/provider-kit/open-error";
import { appendAcpMcp, developerInstructions } from "@ace/mcp-server";
import { AcpConfiguration } from "./configuration.ts";
import type { LaunchOptions, SessionRuntime } from "./runtime.ts";
import { clientMeta } from "./bridge-negotiation.ts";
import { redactLease } from "./frame-redaction.ts";
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
  commandId?: string;
  origin?: "ace";
  bytes: number;
  resolve(): void;
  reject(error: unknown): void;
}
export type { LaunchOptions, SessionRuntime } from "./runtime.ts";
export async function openAcpSession(
  ctx: SessionContext,
  quirks: AcpQuirks,
  launch: LaunchOptions,
  runtime: SessionRuntime = { spawn: spawnSupervised, now: () => performance.now() },
): Promise<ProviderSession> {
  if (ctx.signal.aborted) {
    ctx.mcp?.end();
    throw new Error("ACP session lifetime already ended");
  }
  let proc: SupervisedProcess;
  try {
    proc = runtime.spawn({
      command: launch.command,
      args: launch.args,
      cwd: ctx.cwd,
      ...(ctx.outputFlow ? { outputFlow: ctx.outputFlow } : {}),
      env: launch.env ?? {},
      name: quirks.provider,
    });
  } catch (error) {
    ctx.mcp?.end();
    throw openingError(error, ctx, launch);
  }
  const session = new AcpSession(ctx, quirks, proc, runtime, launch);
  try {
    await session.initialize();
    return session;
  } catch (error) {
    const failure = openingError(error, ctx, launch);
    await session.close("shutdown").catch(() => {});
    throw failure;
  }
}
function openingError(error: unknown, ctx: SessionContext, launch: LaunchOptions): Error {
  return new SessionOpenError(
    "ACP session opening failed",
    error,
    { env: launch.env ?? ctx.env, workspace: ctx.cwd },
    (value) => redactLease(value, ctx.mcp?.secrets ?? []),
  );
}
function sanitizedError(error: unknown, ctx: SessionContext): Error {
  return new Error(
    String(
      redactLease(
        error instanceof Error ? error.message : "ACP operation failed",
        ctx.mcp?.secrets ?? [],
      ),
    ),
  );
}
class AcpSession implements ProviderSession {
  nativeSessionId = "";
  readonly configuration: AcpConfiguration;
  get effectiveCapabilities() {
    return this.configuration.capabilities;
  }
  get acpSupport() {
    return this.configuration.support;
  }
  readonly launch: LaunchOptions;
  queuedBytes = 0;
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
  selecting = false;
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
    launch: LaunchOptions,
  ) {
    this.launch = launch;
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
      onError: (error) => this.fail(error),
    });
    this.configuration = new AcpConfiguration(ctx, quirks, launch, this.rpc);
    this.rpc.onRequest = (request) => this.handleRequest(request);
    this.rpc.onNotification = (notification) => {
      if (notification.method !== "session/update") return;
      const params = object(notification.params);
      const update = object(params["update"]);
      if (
        params["sessionId"] === this.nativeSessionId &&
        update["sessionUpdate"] === "config_option_update" &&
        Array.isArray(update["configOptions"])
      ) {
        this.configuration.update({ configOptions: update["configOptions"] });
      }
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
      ctx.mcp?.end();
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
    this.ctx.mcp?.end();
    this.fault = error;
    this.closed = true;
    this.clearGrace();
    this.frame("note", "transport", { event: "transport-error", message: error.message });
    this.cancelQuestions();
    this.rejectQueue(error);
    this.rpc.stopRequests(error);
    void this.proc.stop();
  }
  abort = (): void => {
    void this.close("shutdown");
  };
  frame(dir: "send" | "recv" | "stderr" | "note", channel: string, data: unknown): void {
    const payload = new ProviderPayload(
      JSON.stringify(redactLease(data, this.ctx.mcp?.secrets ?? [])),
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
    const { AGENT_METHODS, PROTOCOL_VERSION } = await import("@agentclientprotocol/sdk");
    const result = object(
      await this.rpc.request(
        AGENT_METHODS.initialize,
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "ace", version: "0.0.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            _meta: clientMeta(this.quirks.clientMeta, this.launch.profile),
            ...(this.launch.profile?.subagentSessions ? { subagents: {} } : {}),
          },
        },
        { signal: this.ctx.signal },
      ),
    );
    const negotiated = this.configuration.initialize(result);
    const injected = this.ctx.mcp
      ? negotiated.httpMcp
        ? [...this.ctx.mcp.httpServers]
        : [...(this.ctx.mcp.stdioServers ?? [])]
      : [];
    const mcpServers = appendAcpMcp(this.ctx.mcp?.configuredServers ?? [], injected);
    if (!negotiated.httpMcp && mcpServers.some((server) => object(server)["type"] === "http"))
      throw new Error("ACP agent does not advertise HTTP MCP");
    if (!negotiated.sseMcp && mcpServers.some((server) => object(server)["type"] === "sse"))
      throw new Error("ACP agent does not advertise SSE MCP");
    const mcpTransport = injected.length ? (negotiated.httpMcp ? "http" : "stdio") : "unavailable";
    const resume = this.ctx.resume;
    if (resume && !negotiated.capabilities.resume)
      throw new Error("ACP agent does not advertise safe session loading");
    const session = object(
      await this.rpc.request(
        resume ? AGENT_METHODS.session_load : AGENT_METHODS.session_new,
        {
          cwd: this.ctx.cwd,
          mcpServers,
          ...(resume ? { sessionId: resume.nativeSessionId } : {}),
        },
        { signal: this.ctx.signal },
      ),
    );
    this.nativeSessionId = string(session["sessionId"]) || resume?.nativeSessionId || "";
    this.routing.bindRoot(this.nativeSessionId);
    if (!this.nativeSessionId) throw new Error("ACP server did not return a session id");
    this.configuration.setup(session, mcpTransport);
    if (this.ctx.permissionMode) await this.setMode(this.ctx.permissionMode);
    if (this.ctx.model) await this.setModel(this.ctx.model);
  }
  async select(kind: "model" | "mode", value: string): Promise<void> {
    if (
      this.closed ||
      this.active ||
      this.selecting ||
      this.routing.hasLiveChildren ||
      this.pending.size ||
      this.shells.blocked
    )
      throw new Error("ACP selectors require a settled session");
    this.selecting = true;
    try {
      await this.configuration.select(kind, value, this.nativeSessionId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("request timed out")) this.fail(error);
      throw sanitizedError(error, this.ctx);
    } finally {
      this.selecting = false;
      void this.drain();
    }
  }

  setModel(model: string): Promise<void> {
    return this.select("model", model);
  }
  setMode(mode: string): Promise<void> {
    return this.select("mode", mode);
  }
  async send(
    input: ContentPart[],
    _delivery: "steer" | "queue",
    commandId?: string,
    origin?: "ace",
  ): Promise<void> {
    if (this.closed) throw new Error("ACP session closed");
    if (this.shells.blocked) throw new Error("ACP shell execution completion is unconfirmed");
    const inputs = nativeCommandInputs(input);
    const bytes = inputs.reduce(
      (total, parts) => total + Buffer.byteLength(JSON.stringify(parts)),
      0,
    );
    if (this.queue.length + inputs.length > 64 || this.queuedBytes + bytes > 4 * 1024 * 1024)
      throw new Error("ACP input queue capacity reached");
    await Promise.all(
      inputs.map(
        (parts) =>
          new Promise<void>((resolve, reject) => {
            const partBytes = Buffer.byteLength(JSON.stringify(parts));
            this.queuedBytes += partBytes;
            this.queue.push({
              input: structuredClone(parts),
              ...(commandId ? { commandId } : {}),
              ...(origin ? { origin } : {}),
              bytes: partBytes,
              resolve,
              reject,
            });
            this.queueChanged();
            void this.drain();
          }),
      ),
    );
  }
  queueChanged(): void {
    this.frame("note", "recorder", { event: "queue-changed", count: this.queue.length });
  }
  async drain(): Promise<void> {
    if (
      this.active ||
      this.selecting ||
      this.closed ||
      this.routing.hasLiveChildren ||
      this.pending.size ||
      this.shells.blocked
    )
      return;
    const next = this.queue.shift();
    if (!next) return;
    this.queuedBytes -= next.bytes;
    this.active = true;
    this.queueChanged();
    try {
      if (next.commandId) {
        this.ctx.onInputMessage?.({ commandId: next.commandId, nativeId: next.commandId });
        this.frame("note", "recorder", {
          event: "input-sending",
          nativeId: next.commandId,
          ...(next.origin ? { origin: next.origin } : {}),
        });
      }
      const result = await this.rpc.request(
        "session/prompt",
        {
          sessionId: this.nativeSessionId,
          prompt: [
            // ACP has no portable system-instruction field. Native prompt context is the
            // interoperable fallback, refreshed each turn so compaction cannot erase it.
            ...(this.ctx.mcp
              ? [
                  {
                    type: "text",
                    text: `<ace-tool-guidance>\n${developerInstructions(this.quirks.provider)}\n</ace-tool-guidance>`,
                  },
                ]
              : []),
            ...next.input.map(encodeContent),
          ],
        },
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
      next.reject(sanitizedError(error, this.ctx));
    } finally {
      this.active = false;
      void this.drain();
    }
  }
  handleRequest(request: ServerRequest): unknown | Promise<unknown> {
    const params = object(request.params);
    if (["cursor/task", "cursor/update_todos", "cursor/generate_image"].includes(request.method))
      return {};
    if (!interactionRequest(request.method, params, this.quirks.provider === "antigravity"))
      throw new MethodNotFound();
    if (this.closed) return { outcome: { outcome: "cancelled" } };
    if (this.pending.has(interactionKey(request.id)))
      throw new Error("Duplicate pending ACP request");
    if (this.pending.size >= 128) {
      this.fail(new Error("ACP incoming interaction capacity reached"));
      throw new Error("ACP interaction capacity reached");
    }
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
    void this.drain();
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
      this.ctx.signal.removeEventListener("abort", this.abort);
    }
    this.ctx.mcp?.end();
    await this.proc.stop();
    this.rpc.close();
  }
  rejectQueue(error: Error): void {
    for (const job of this.queue.splice(0)) job.reject(error);
    this.queuedBytes = 0;
    this.queueChanged();
  }
}
