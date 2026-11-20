import { nativeCommandInputs } from "@ace/commands/invocation";
import { SessionOpenError } from "@ace/provider-kit/open-error";
import { resumeLoadFailure } from "./resume-error.ts";
import { appendAcpMcp, developerInstructions } from "@ace/mcp-server";
import { AcpConfiguration, LegacyModelRejected } from "./configuration.ts";
import type { LaunchOptions, SessionRuntime } from "./runtime.ts";
import { openWithSignIn } from "@ace/provider-kit/acp-sign-in";
import { clientMeta } from "./bridge-negotiation.ts";
import { redactLease, redactedFrameJson } from "./frame-redaction.ts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { elidedJson } from "@ace/provider-kit/binary-elision";
import { ShellSettlement } from "./shell-settlement.ts";
import {
  answerIsNeutral,
  answerRefusesTool,
  cancellationGraceMs,
  promptEnd,
} from "./settlement.ts";
import { Deadlines } from "./deadlines.ts";
import { requestTool } from "./requests.ts";
import {
  InputRejected,
  SteerTargetLost,
  type InputSource,
  type ProviderSession,
  type SessionContext,
  type SteerFence,
} from "@ace/engine-api";
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
/** One send; a command input can expand into several prompts. */
interface Batch {
  /** Set once any of its prompts reached the transport; from then on it may have run. */
  written: boolean;
}
interface Queued {
  batch: Batch;
  input: ContentPart[];
  commandId?: string;
  origin?: InputSource;
  /** A fenced steer: written only while its turn is still current (ACP writes when idle). */
  fence?: SteerFence;
  bytes: number;
  resolve(): void;
  reject(error: unknown): void;
}
export type { LaunchOptions, SessionRuntime } from "./runtime.ts";
const openStallMs = 30_000;
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
  refusedOptions: string[] = [];
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
  /** Cancellation confirmations still owed: "children", "root", "shells", "child:<id>". */
  readonly deadlines: Deadlines;
  /** Children cancelled directly whose end is still owed; only these are checked per update. */
  readonly cancellingChildren = new Set<string>();
  fault?: Error;
  readonly queue: Queued[] = [];
  active = false;
  selecting = false;
  /** session/load is in flight: its replayed updates are history, not live work. */
  loading = false;
  closed = false;
  deliberate = false;
  /** Whether this connection has carried ace's guidance (system prompt or first prompt). */
  guided = false;
  /** ace's tool guidance for this session. */
  guidance(mcp: NonNullable<SessionContext["mcp"]>): string {
    return (
      mcp.instructions ?? developerInstructions(this.quirks.provider, this.ctx.aceMcp?.session?.())
    );
  }
  sequence = 0;
  /** session/prompt frames handed to the transport, to tell a written prompt from one that never left. */
  promptFrames = 0;
  promptId: unknown;
  /** The id of the session/new, load or resume request in flight. */
  openId: unknown;
  /** The session being opened, while it is: a resumed id, or the new one once it speaks. */
  openingSession = "";
  /** Aborts the session open when the agent goes silent; re-armed by every frame it sends. */
  openStalled?: () => void;
  readonly started: number;
  readonly now: () => number;
  /**
   * Windows has no SIGTERM for a console child: taskkill without /F cannot end it. Closing the
   * agent's stdin is the polite stop there, before the tree stop escalates.
   */
  readonly windows: boolean;
  constructor(
    ctx: SessionContext,
    quirks: AcpQuirks,
    proc: SupervisedProcess,
    runtime: SessionRuntime,
    launch: LaunchOptions,
  ) {
    this.launch = launch;
    this.now = runtime.now;
    this.windows = (runtime.platform ?? process.platform) === "win32";
    this.started = runtime.now();
    this.shells = new ShellSettlement(quirks);
    this.routing = new SessionRouting(ctx.threadId, ctx.resume?.nativeSessionId ?? "");
    this.schedule =
      runtime.schedule ??
      ((delay, run) => {
        const timer = setTimeout(run, delay);
        return () => clearTimeout(timer);
      });
    this.deadlines = new Deadlines(this.schedule);
    this.ctx = ctx;
    this.quirks = quirks;
    this.proc = proc;
    this.rpc = new JsonRpcPeer(proc, {
      onFrame: (dir, data) => {
        // Settlement happens here, in frame order, as the translator sees it. A continuation after
        // `await reply` would run only after every later frame of the same stdout chunk.
        const message = object(data);
        if (dir === "send") this.sending(message);
        else {
          if (this.openStalled) this.deadlines.arm("open", openStallMs, this.openStalled);
          if (message["method"] === undefined) this.replied(message);
        }
        this.frame(dir, "stdio", data);
      },
      onMalformed: (line) => this.frame("recv", "stdio-text", line),
      onError: (error) => this.fail(error),
    });
    this.configuration = new AcpConfiguration(ctx, quirks, launch, this.rpc);
    this.rpc.onRequest = (request) => this.handleRequest(request);
    this.rpc.onNotification = (notification) => {
      if (notification.method !== "session/update") return;
      const params = object(notification.params);
      const update = object(params["update"]);
      const sessionId = string(params["sessionId"]);
      // Antigravity names a new session in its updates before answering session/new.
      if (this.openId !== undefined && !this.openingSession && !this.nativeSessionId)
        this.openingSession = sessionId;
      if (
        sessionId !== "" &&
        sessionId === (this.nativeSessionId || this.openingSession) &&
        update["sessionUpdate"] === "config_option_update" &&
        Array.isArray(update["configOptions"])
      ) {
        this.configuration.update({ configOptions: update["configOptions"] });
      } else if (
        params["sessionId"] === this.nativeSessionId &&
        update["sessionUpdate"] === "current_mode_update" &&
        typeof update["currentModeId"] === "string"
      )
        this.configuration.modeChanged(update["currentModeId"]);
      // The translator drops load replay too; replayed tools and children are not running now.
      if (this.loading) return;
      this.routing.receive(object(notification.params));
      this.shells.receive(object(notification.params));
      if (!this.routing.hasLiveChildren) this.deadlines.clear("children");
      if (!this.shells.blocked) this.deadlines.clear("shells");
      for (const id of this.cancellingChildren)
        if (!this.routing.live.has(id)) {
          this.cancellingChildren.delete(id);
          this.deadlines.clear(`child:${id}`);
        }
      // drain() settles each turn it takes, so its rejection has no reporter here.
      void this.drain().catch(() => {});
    };
    proc.stdout.once("close", this.stdoutClosed);
    proc.stderr.on("line", (line) => this.frame("stderr", "stdio", line));
    ctx.signal.addEventListener("abort", this.abort, { once: true });
    // exited never rejects; the exit itself reaches the engine through onExit.
    void proc.exited
      .then((exit) => {
        this.closed = true;
        ctx.mcp?.end();
        this.deadlines.clearAll();
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
      })
      .catch(() => {});
    this.frame("note", "recorder", { event: "process-start" });
    if (ctx.signal.aborted) this.abort();
  }
  sending(message: Record<string, unknown>): void {
    const method = message["method"];
    if (method === "session/prompt") {
      this.promptFrames++;
      this.promptId = message["id"];
      this.shells.promptStarted();
    }
    if (method === "session/new" || method === "session/load" || method === "session/resume") {
      this.openId = message["id"];
      // Only session/load replays history; its replayed updates are not live work.
      this.loading = method === "session/load";
    }
  }
  replied(message: Record<string, unknown>): void {
    const id = message["id"];
    if (id === undefined) return;
    if (id === this.openId) {
      this.openId = undefined;
      this.loading = false;
      if (message["error"] === undefined) {
        this.nativeSessionId =
          string(object(message["result"])["sessionId"]) ||
          this.ctx.resume?.nativeSessionId ||
          this.openingSession;
        this.routing.bindRoot(this.nativeSessionId);
        this.shells.root = this.nativeSessionId;
      }
      return;
    }
    if (id !== this.promptId) return;
    const end = promptEnd(message);
    // No stop reason: the continuation fails the session, completion being unconfirmed.
    if (!end) return;
    this.promptId = undefined;
    this.promptEnded(end.reason);
  }
  /** The prompt's reply frame: everything its end closes closes now, before any later frame. */
  promptEnded(reason: string): void {
    const root = this.nativeSessionId;
    this.deadlines.clear("root");
    // The translator closes the turn's open requests at its end; nothing can answer them now.
    this.cancelQuestions(reason === "cancelled" ? undefined : new Set([root]));
    this.shells.promptEnded(root, reason);
    this.routing.promptEnded();
    if (reason !== "cancelled") return;
    if (this.routing.hasLiveChildren)
      this.deadlines.arm("children", cancellationGraceMs, () => {
        if (this.routing.hasLiveChildren)
          this.fail(new Error("ACP child cancellation completion is unconfirmed after grace"));
      });
    // A cancelled shell the agent never reports again would refuse input forever.
    if (this.shells.blocked)
      this.deadlines.arm("shells", cancellationGraceMs, () => {
        if (this.shells.blocked)
          this.fail(new Error("ACP shell cancellation completion is unconfirmed after grace"));
      });
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
    this.deadlines.clearAll();
    this.frame("note", "transport", { event: "transport-error", message: error.message });
    this.cancelQuestions();
    this.rejectQueue(error);
    this.rpc.stopRequests(error);
    if (this.windows) {
      // stopTree notes a tree that survives its stop itself.
      void this.stopTree().catch(() => {});
      return;
    }
    // stop() warns a surviving tree itself.
    void this.proc.stop().catch(() => {});
  }
  abort = (): void => {
    // A tree that outlived its stop is noted by stopTree; shutdown goes on.
    void this.close("shutdown").catch(() => {});
  };
  frame(dir: "send" | "recv" | "stderr" | "note", channel: string, data: unknown): void {
    let redacted = data;
    let payload: ProviderPayload;
    try {
      const frame = redactedFrameJson(data, this.ctx.mcp?.secrets ?? []);
      redacted = frame.value;
      payload = new ProviderPayload(frame.json);
    } catch (error) {
      // Images the translator shows inline stay whole while they fit. Attachment bytes alone
      // never push a frame past its bound and end the session: they are elided instead.
      if (!(error instanceof RangeError)) throw error;
      if (redacted === data) redacted = redactLease(data, this.ctx.mcp?.secrets ?? []);
      payload = new ProviderPayload(elidedJson(redacted));
    }
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
    if (negotiated.versionChanged)
      this.frame("note", "diagnostic", {
        event: "acp-version-changed",
        ...negotiated.versionChanged,
      });
    // In its profile's range but not a version ace verified the profile on (ADR 0044 amendment).
    if (negotiated.profile && negotiated.profileFit === "compatible")
      this.frame("note", "diagnostic", {
        event: "acp-version-unverified",
        profile: negotiated.profile.id,
        verified: negotiated.profile.version,
        version: negotiated.versionChanged?.reported ?? this.launch.version,
      });
    const injected = this.ctx.mcp
      ? negotiated.httpMcp
        ? [...this.ctx.mcp.httpServers]
        : [...(this.ctx.mcp.stdioServers ?? [])]
      : [];
    // A server the person configured that this agent can't reach is left out and said so; the
    // rest of the session still works. ace's own server always picks a transport the agent takes.
    const configured = (this.ctx.mcp?.configuredServers ?? []).filter((server) => {
      const type = object(server)["type"];
      const unsupported =
        (type === "http" && !negotiated.httpMcp) || (type === "sse" && !negotiated.sseMcp);
      if (unsupported)
        this.frame("note", "recorder", {
          event: "mcp-server-skipped",
          name: string(object(server)["name"]),
          transport: type,
        });
      return !unsupported;
    });
    const mcpServers = appendAcpMcp(configured, injected);
    const mcpTransport = injected.length ? (negotiated.httpMcp ? "http" : "stdio") : "unavailable";
    const resume = this.ctx.resume;
    if (resume && !negotiated.capabilities.resume)
      throw openingError(
        { code: "resume_unsupported", detail: "ACP agent does not advertise safe session loading" },
        this.ctx,
        this.launch,
      );
    // An agent that takes system-prompt text gets ace's guidance there, on every new or loaded
    // session, instead of in the first prompt where it would stay in the conversation.
    const systemPrompt =
      negotiated.systemPromptAppend && this.ctx.mcp ? this.guidance(this.ctx.mcp) : undefined;
    let opened: unknown;
    if (resume) this.openingSession = resume.nativeSessionId;
    // Opening has no fixed timeout: a long replay or slow MCP connects are progress. It fails only
    // when the agent says nothing at all for a while.
    const stalled = new AbortController();
    this.openStalled = () =>
      stalled.abort(new Error("ACP session opening made no progress within 30 seconds"));
    this.deadlines.arm("open", openStallMs, this.openStalled);
    const signal = AbortSignal.any([this.ctx.signal, stalled.signal]);
    try {
      opened = await openWithSignIn(
        this.rpc,
        this.launch.signInMethod,
        () =>
          this.rpc.request(
            resume
              ? negotiated.resumeMethod === "session/resume"
                ? AGENT_METHODS.session_resume
                : AGENT_METHODS.session_load
              : AGENT_METHODS.session_new,
            {
              cwd: this.ctx.cwd,
              mcpServers,
              ...(resume ? { sessionId: resume.nativeSessionId } : {}),
              ...(systemPrompt
                ? { _meta: { antigravity: { systemPrompt: { append: systemPrompt } } } }
                : {}),
            },
            { signal, timeoutMs: null },
          ),
        signal,
      );
    } catch (error) {
      const failure = resume ? resumeLoadFailure(error) : undefined;
      if (failure) throw openingError(failure, this.ctx, this.launch);
      throw error;
    } finally {
      this.loading = false;
      this.openId = undefined;
      delete this.openStalled;
      this.deadlines.clear("open");
    }
    if (systemPrompt) this.guided = true;
    const session = object(opened);
    // The reply frame already named the session (replied()), before any update after it.
    if (!this.nativeSessionId) throw new Error("ACP server did not return a session id");
    this.configuration.setup(session, mcpTransport);
    // A saved mode or model the agent no longer lists (renamed, dropped, or a loaded session
    // that reports none) or refuses doesn't stop the start: the daemon is told it didn't apply.
    // An access mode that didn't apply is never claimed: the daemon records what runs instead.
    const mode = this.ctx.permissionMode;
    if (mode && !(await this.attempt(() => this.setMode(mode))))
      this.refusedOptions.push("permissionMode");
    if (this.ctx.model && !(await this.attempt(() => this.setModel(this.ctx.model ?? ""))))
      this.refusedOptions.push("model");
    // Effort follows the model: the model's own thinking levels arrive with its selection. An
    // agent that refuses the level keeps its default; a start never fails over effort, and the
    // daemon is told so the thread stops showing a level that isn't running.
    const effort = this.ctx.options?.["effort"];
    if (typeof effort === "string" && !(await this.selectEffort(effort)))
      this.refusedOptions.push("effort");
  }
  /** Whether a selection at start applied; a closed session still fails the start. */
  private async attempt(select: () => Promise<void>): Promise<boolean> {
    try {
      await select();
      return true;
    } catch (error) {
      if (this.closed) throw error;
      return false;
    }
  }
  /** The native mode the session reports running, when it reports one. */
  get permissionMode(): string | undefined {
    return this.configuration.current("mode");
  }
  async selectEffort(effort: string): Promise<boolean> {
    if (!this.configuration.selectors.effort?.values.includes(effort)) return false;
    try {
      await this.configuration.select("effort", effort, this.nativeSessionId);
      return true;
    } catch {
      return false;
    }
  }
  /** Selections run one at a time, in the order asked; one never refuses another in flight. */
  private selections: Promise<void> = Promise.resolve();
  select(kind: "model" | "mode" | "effort", value: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("ACP selectors require a settled session"));
    const run = this.selections.then(() => this.selectNow(kind, value));
    this.selections = run.catch(() => {});
    return run;
  }
  private async selectNow(kind: "model" | "mode" | "effort", value: string): Promise<void> {
    // ACP lets a client change the session mode at any time, a running turn included, so a new
    // access mode lands at once. Model and effort still change only between turns.
    if (this.closed) throw new Error("ACP selectors require a settled session");
    if (
      kind !== "mode" &&
      (this.active || this.routing.hasLiveChildren || this.pending.size || this.shells.blocked)
    )
      throw new Error("ACP selectors require a settled session");
    this.selecting = true;
    try {
      await this.configuration.select(kind, value, this.nativeSessionId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("request timed out")) this.fail(error);
      if (error instanceof LegacyModelRejected)
        this.frame("note", "diagnostic", {
          event: "acp-legacy-model-rejected",
          requested: value,
          unsupported: error.unsupported,
        });
      throw sanitizedError(error, this.ctx);
    } finally {
      this.selecting = false;
      // drain() settles each turn it takes, so its rejection has no reporter here.
      void this.drain().catch(() => {});
    }
  }

  /** The mode ace last set; a model's reply that resets it gets it back. */
  private wantedMode: string | undefined;
  async setModel(model: string): Promise<void> {
    const before = this.configuration.current("mode");
    await this.select("model", model);
    const now = this.configuration.current("mode");
    if (now === before) return;
    // A model's reply can carry a fresh set of options with the mode back at its default.
    if (this.wantedMode && now !== this.wantedMode)
      try {
        await this.select("mode", this.wantedMode);
        return;
      } catch {
        // The owner hears which mode runs now instead.
      }
    this.configuration.announceMode();
  }
  async setMode(mode: string): Promise<void> {
    await this.select("mode", mode);
    this.wantedMode = mode;
  }
  async send(
    input: ContentPart[],
    delivery: "steer" | "queue",
    commandId?: string,
    origin?: InputSource,
    fence?: SteerFence,
  ): Promise<void> {
    // Refusals before queueing write nothing, so the agent provably took none of the input.
    if (this.closed) throw new InputRejected("ACP session closed");
    if (this.shells.blocked)
      throw new InputRejected("ACP shell execution completion is unconfirmed");
    const inputs = nativeCommandInputs(input);
    const bytes = inputs.reduce(
      (total, parts) => total + Buffer.byteLength(JSON.stringify(parts)),
      0,
    );
    if (this.queue.length + inputs.length > 64 || this.queuedBytes + bytes > 4 * 1024 * 1024)
      throw new InputRejected("ACP input queue capacity reached");
    const batch: Batch = { written: false };
    try {
      await this.enqueue(
        inputs,
        batch,
        commandId,
        origin,
        delivery === "steer" ? fence : undefined,
      );
    } catch (error) {
      if (batch.written) throw error;
      // No prompt of this send reached the agent; drop the rest so none goes out later.
      this.dropBatch(batch);
      if (error instanceof InputRejected) throw error;
      throw new InputRejected(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
  }
  private enqueue(
    inputs: ContentPart[][],
    batch: Batch,
    commandId: string | undefined,
    origin: InputSource | undefined,
    fence: SteerFence | undefined,
  ): Promise<void[]> {
    return Promise.all(
      inputs.map(
        (parts) =>
          new Promise<void>((resolve, reject) => {
            const partBytes = Buffer.byteLength(JSON.stringify(parts));
            this.queuedBytes += partBytes;
            this.queue.push({
              batch,
              input: structuredClone(parts),
              ...(commandId ? { commandId } : {}),
              ...(origin ? { origin } : {}),
              ...(fence ? { fence } : {}),
              bytes: partBytes,
              resolve,
              reject,
            });
            this.queueChanged();
            // drain() settles each turn it takes, so its rejection has no reporter here.
            void this.drain().catch(() => {});
          }),
      ),
    );
  }
  private dropBatch(batch: Batch): void {
    const kept = this.queue.filter((job) => job.batch !== batch);
    if (kept.length === this.queue.length) return;
    for (const job of this.queue) if (job.batch === batch) this.queuedBytes -= job.bytes;
    this.queue.splice(0, this.queue.length, ...kept);
    this.queueChanged();
  }
  queueChanged(): void {
    this.frame("note", "recorder", { event: "queue-changed", count: this.queue.length });
  }
  async drain(): Promise<void> {
    if (
      this.active ||
      this.selecting ||
      this.closed ||
      this.routing.holdsInput ||
      this.pending.size ||
      this.shells.blocked ||
      this.shells.busy
    )
      return;
    const next = this.queue.shift();
    if (!next) return;
    // Its turn ended before ACP was idle to take it: refused unread, never written into another.
    if (next.fence && !next.fence.current() && !next.batch.written) {
      this.queuedBytes -= next.bytes;
      next.reject(new SteerTargetLost());
      this.queueChanged();
      return void this.drain();
    }
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
      // ACP has no portable system-instruction field, so ace's guidance rides in prompt context:
      // once per connection (a new or loaded session), never every turn, where each copy would
      // stay in history and re-bill. ACP reports no compaction, so there is no signal to resend on.
      const guidance = this.guided ? undefined : this.ctx.mcp;
      const written = this.promptFrames;
      const reply = this.rpc.request(
        "session/prompt",
        {
          sessionId: this.nativeSessionId,
          prompt: [
            ...(guidance
              ? [
                  {
                    type: "text",
                    text: `<ace-tool-guidance>\n${this.guidance(guidance)}\n</ace-tool-guidance>`,
                  },
                ]
              : []),
            ...next.input.map(encodeContent),
          ],
        },
        { timeoutMs: null, signal: this.ctx.signal },
      );
      // The request frame goes out synchronously, or the request fails without writing it.
      if (this.promptFrames !== written) next.batch.written = true;
      const promptId = this.promptId;
      try {
        const result = await reply;
        if (guidance) this.guided = true;
        // Its reply frame already settled the prompt (replied()), unless it named no stop reason.
        if (!promptEnd({ result })) {
          const error = new Error("ACP prompt completion is unconfirmed");
          this.fail(error);
          throw error;
        }
      } finally {
        // No reply frame (the transport failed): the prompt's tools ended with it.
        if (next.batch.written && this.promptId === promptId) {
          this.promptId = undefined;
          this.shells.promptEnded(this.nativeSessionId, "");
        }
      }
      if (this.shells.blocked)
        this.rejectQueue(new Error("ACP shell execution completion is unconfirmed"));
      next.resolve();
    } catch (error) {
      next.reject(sanitizedError(error, this.ctx));
    } finally {
      this.active = false;
      // drain() settles each turn it takes, so its rejection has no reporter here.
      void this.drain().catch(() => {});
    }
  }
  handleRequest(request: ServerRequest): unknown | Promise<unknown> {
    const params = object(request.params);
    if (["cursor/task", "cursor/update_todos", "cursor/generate_image"].includes(request.method))
      return {};
    if (!interactionRequest(request.method, params, this.quirks)) throw new MethodNotFound();
    if (this.closed) return { outcome: { outcome: "cancelled" } };
    if (this.pending.has(interactionKey(request.id)))
      throw new Error("Duplicate pending ACP request");
    if (this.pending.size >= 128) {
      this.fail(new Error("ACP incoming interaction capacity reached"));
      throw new Error("ACP interaction capacity reached");
    }
    const owner = this.routing.owner(params, this.nativeSessionId);
    // An approval-first tool: the request is the first the agent says of it. The translator shows
    // that tool from the request, so shell settlement learns it from the same decoding.
    const tool = requestTool(request.method, params);
    if (tool && !this.shells.knows(owner, tool.toolCallId))
      this.shells.receive({ sessionId: owner, update: tool });
    return new Promise((resolve) =>
      this.pending.set(interactionKey(request.id), { request, owner, answer: resolve }),
    );
  }
  async resolve(key: string, resolution: InteractionResolution): Promise<void> {
    const pending = this.pending.get(key);
    if (!pending) throw new Error("ACP interaction is no longer pending");
    // The request as published: lease secrets redacted, as the translator read it.
    const native = object(pending.request.params);
    const published = object(redactLease(native, this.ctx.mcp?.secrets ?? []));
    const request = interactionRequest(pending.request.method, published, this.quirks);
    if (!request) throw new Error("Interaction request is no longer valid");
    const validated = validateResolution(request, resolution);
    const answer = encodeResolution(
      pending.request.method,
      { published, native },
      validated,
      request,
    );
    this.pending.delete(key);
    if (!answerIsNeutral(request, validated))
      this.answered(pending, answerRefusesTool(request, validated, false));
    pending.answer(answer);
    // drain() settles each turn it takes, so its rejection has no reporter here.
    void this.drain().catch(() => {});
  }
  cancelQuestions(owners?: Set<string>, only?: ReadonlySet<string>): void {
    for (const [key, pending] of this.pending)
      if ((!owners || owners.has(pending.owner)) && (!only || only.has(key))) {
        this.answered(pending, true);
        pending.answer({ outcome: { outcome: "cancelled" } });
        this.pending.delete(key);
      }
  }
  /** Tells shell settlement how a tool's request was answered, as the translator sees it. */
  answered(pending: PendingInteraction, refused: boolean): void {
    const params = object(pending.request.params);
    const tool = string(params["toolCallId"] ?? object(params["toolCall"])["toolCallId"]);
    if (tool) this.shells.answered(pending.owner, tool, refused);
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
    // notify() reports a failed send through the peer's onError.
    void this.rpc.notify("session/cancel", { sessionId: id }).catch(() => {});
    if (child) {
      // A child that goes silent after its cancel is given up as interrupted, as the translator
      // does at the same deadline, so it no longer holds input back.
      for (const cancelled of [child, ...descendants])
        if (cancelled.live && cancelled.cancel) this.expireAfterGrace(cancelled.id);
    } else if (this.promptId !== undefined && !this.deadlines.has("root")) {
      // A stop the agent never answers would hang the thread: recover by restarting it.
      this.deadlines.arm("root", cancellationGraceMs, () => {
        if (this.promptId !== undefined)
          this.fail(new Error("ACP prompt cancellation is unconfirmed after grace"));
      });
    }
    for (const descendant of descendants)
      if (descendant.live && descendant.cancel)
        void this.rpc.notify("session/cancel", { sessionId: descendant.id }).catch(() => {});
  }
  expireAfterGrace(id: string): void {
    this.cancellingChildren.add(id);
    this.deadlines.arm(`child:${id}`, cancellationGraceMs, () => {
      this.cancellingChildren.delete(id);
      if (!this.routing.expire(id)) return;
      if (!this.routing.hasLiveChildren) this.deadlines.clear("children");
      // drain() settles each turn it takes, so its rejection has no reporter here.
      void this.drain().catch(() => {});
    });
  }
  async stopTask(_task: string): Promise<void> {
    throw new Error("ACP does not expose individual background task control");
  }
  async close(_reason: "idle" | "user" | "shutdown"): Promise<void> {
    if (!this.proc.signal.aborted && !this.fault) this.deliberate = true;
    if (!this.closed) {
      this.closed = true;
      this.deadlines.clearAll();
      this.proc.stdout.removeListener("close", this.stdoutClosed);
      this.frame("note", "recorder", { event: "stop" });
      this.cancelQuestions();
      this.rejectQueue(new Error("ACP session closed"));
      this.ctx.signal.removeEventListener("abort", this.abort);
    }
    this.ctx.mcp?.end();
    if (this.windows) {
      await this.stopTree();
      this.rpc.close();
      return;
    }
    await this.proc.stop();
    this.rpc.close();
  }
  /** Windows: EOF is the polite stop; the recorded tree is gone before this resolves. */
  #treeStop: Promise<unknown> | undefined;
  stopTree(): Promise<unknown> {
    if (this.#treeStop) return this.#treeStop;
    const stopping = import("@ace/provider-kit/tree-stop").then(({ stopTreeAfterEof }) =>
      stopTreeAfterEof(this.proc, 5_000),
    );
    // Awaiting callers still see the failure; a voided stop (a transport fault) leaves it here.
    stopping.catch((error: unknown) =>
      this.frame("note", "transport", { event: "tree-stop-failed", message: String(error) }),
    );
    this.#treeStop = stopping;
    return stopping;
  }
  rejectQueue(error: Error): void {
    for (const job of this.queue.splice(0)) job.reject(error);
    this.queuedBytes = 0;
    this.queueChanged();
  }
}
