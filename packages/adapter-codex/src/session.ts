import { z } from "zod";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import { accessModeOffers, codexAccessAvailable } from "@ace/provider-kit/access-modes";
import { codexCapabilities } from "./capabilities.ts";
import { createExtensionCatalog, optionalCatalogFrames } from "./extension-catalog.ts";
import { codexMcpControls } from "./mcp-controls.ts";
import { sessionDiscovery } from "./session-discovery.ts";
import { sessionLifetime } from "./session-lifetime.ts";
import { RecentSet } from "./retention.ts";
import { isAsyncQuestion, rememberHistoricalQuestions } from "./interaction-lifecycle.ts";
import { codexInjection, redactMcpCredential } from "@ace/mcp-server";
import { configuredTurnPolicy } from "./default-permissions.ts";
import { codexThreadPolicy, codexTurnPolicy } from "./permission-policy.ts";
import { CodexSelectionOptions } from "./selection.ts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { isInteractiveRequest } from "./interactions.ts";
import { runtime, type CodexRuntime } from "./runtime.ts";
import { hydrateControls } from "./session-state.ts";
import { compactHistoryReply } from "./history.ts";
import type { ProviderSession } from "@ace/engine-api";
import type { CodexSessionContext } from "./session-context.ts";
import { type DiscoveryOptions, type DiscoveryResult } from "@ace/provider-kit/discovery";
import { MethodNotFound, type Notification, type ServerRequest } from "@ace/provider-kit/jsonrpc";
import type { ChannelHandlers, CodexChannel } from "./host.ts";
import { openChannel, type CodexHostPool } from "./host-pool.ts";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts";
import { createSessionCommands, type Pending } from "./session-commands.ts";
import { asyncKey, list, obj, planKey, questions, requestKey, str } from "./native.ts";
import { readRateLimits } from "./rate-limits-read.ts";

export type CodexOptions = {
  discovery?: DiscoveryOptions;
  cli?: DiscoveryResult;
  runtime?: Partial<CodexRuntime>;
  /** Shared app-servers. Absent, each session runs a private process. */
  hosts?: CodexHostPool;
};
export async function openCodexSession(
  ctx: CodexSessionContext,
  options: CodexOptions = {},
): Promise<ProviderSession> {
  let permissionMode = ctx.permissionMode ?? null;
  let appliedPermissionMode = permissionMode;
  let selectedOptions = CodexSelectionOptions.parse(ctx.options ?? {});
  if (ctx.fork && ctx.resume) throw new Error("Fork and resume are exclusive");
  if (ctx.fork?.point.type === "item")
    throw new Error("Codex supports native turn boundaries only");
  if (ctx.signal.aborted) throw ctx.signal.reason;
  const io = { ...runtime, ...options.runtime };
  const scope = io.sessionId();
  const interactionKey = (id: unknown) => requestKey(id, scope);
  const seenQuestions = new Set<string>();
  const injection = ctx.aceMcp ? codexInjection(ctx.aceMcp) : undefined;
  let link: CodexChannel | undefined;
  const started = io.now();
  let sequence = 0;
  let nativeSessionId = "";
  let model = ctx.model ?? "";
  let closed = false;
  const active = new Map<string, string>();
  const controlRequests = new Map<
    unknown,
    {
      method: string;
      thread: string;
      mode: string | null;
      completed: Set<string>;
      /** History follows in bounded pages instead of in this reply (#693). */
      excludesTurns: boolean;
    }
  >();
  const correlationDeadlines = new Map<unknown, () => void>();
  function awaitCorrelation(id: unknown, thread: string): void {
    if (correlationDeadlines.has(id)) return;
    const deadline = io.now() + 30_000;
    const expire = () => {
      if (closed || !controlRequests.has(id)) return;
      const remaining = deadline - io.now();
      if (remaining > 0) {
        correlationDeadlines.set(id, io.schedule(expire, remaining));
        return;
      }
      // Local RPC rejection cannot resolve translation's held completion. Retire the owned peer.
      emit("note", { event: "turn-correlation-timeout", threadId: thread });
      void lifetime.failTransport();
    };
    correlationDeadlines.set(id, io.schedule(expire, deadline - io.now()));
  }
  const revisions = new Map<string, number>();
  const reading = new Set<string>();
  const scopedReads = new Set<unknown>();
  const parents = new Map<string, string>();
  const known = new Set<string>();
  const endedTurns = new RecentSet();
  const historyReplies = new Set<unknown>();
  // Confirmed ancestry does not prove that retained history is complete.
  const recovered = new Set<string>();
  const shells = new Map<string, string>();
  const completedShells = new Set<string>();
  const pending = new Map<string, Pending>();
  const asyncQuestions: import("./session-commands.ts").SessionCommandsContext["asyncQuestions"] =
    new Map();
  const plans = new Map<string, { thread: string; markdown: string }>();
  const timers = new Map<string, () => void>();
  const optionalFrames = optionalCatalogFrames();
  const emit = (
    dir: "send" | "recv" | "stderr" | "note",
    data: unknown,
    channel = "stdio",
    optionalMethod?: string,
  ) => {
    const encoded = redactMcpCredential(JSON.stringify(data), ctx.aceMcp);
    let payload: ProviderPayload;
    try {
      payload = new ProviderPayload(encoded);
    } catch (error) {
      if (!optionalMethod || !(error instanceof RangeError)) {
        // A rejected incoming execution frame makes the peer detach. Its process is ours.
        if (dir === "recv") void lifetime.failTransport();
        throw error;
      }
      emit("note", {
        event: "optional-catalog-frame-omitted",
        method: optionalMethod,
        bytes: Buffer.byteLength(encoded),
        reason: error.message,
      });
      return;
    }
    ctx.onFrame({
      seq: sequence++,
      t: Math.round(io.now() - started),
      dir,
      channel,
      data: payload.data,
      payload,
    });
  };
  const diagnostic = (error: unknown) =>
    emit("stderr", error instanceof Error ? error.message : String(error));
  const handlers: ChannelHandlers = {
    ...(ctx.outputFlow ? { flow: ctx.outputFlow } : {}),
    frame(dir, data) {
      const m = obj(data);
      const p = obj(m["params"]);
      const method = str(m["method"]);
      const thread = str(p["threadId"]);
      const submittedMode = permissionMode;
      if (
        dir === "send" &&
        ["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(method)
      )
        controlRequests.set(m["id"], {
          method,
          thread,
          mode: submittedMode,
          completed: new RecentSet(),
          excludesTurns: p["excludeTurns"] === true,
        });
      if (dir === "recv") {
        observeRecovery(thread, method, str(obj(p["turn"])["id"]));
        if (method === "turn/completed") endedTurns.add(str(obj(p["turn"])["id"]));
        if (method === "turn/completed")
          for (const [id, submitted] of controlRequests)
            if (submitted.method === "turn/start" && submitted.thread === thread) {
              submitted.completed.add(str(obj(p["turn"])["id"]));
              awaitCorrelation(id, thread);
            }
        const control = method ? undefined : controlRequests.get(m["id"]);
        if (!method) {
          correlationDeadlines.get(m["id"])?.();
          correlationDeadlines.delete(m["id"]);
          controlRequests.delete(m["id"]);
        }
        const result = obj(m["result"]);
        const snapshot = obj(result["thread"]);
        if (control && m["error"] === undefined) {
          if (control.method === "turn/start") {
            const id = str(obj(result["turn"])["id"]);
            if (id && !control.completed.has(id)) active.set(control.thread, id);
            if (id && control.thread === nativeSessionId) {
              appliedPermissionMode = control.mode;
              emit("note", { event: "permission-mode-applied", mode: control.mode });
            }
          } else {
            nativeSessionId = str(snapshot["id"]);
            if (nativeSessionId) {
              known.add(nativeSessionId);
              if (!control.excludesTurns) {
                if (Array.isArray(snapshot["turns"])) recovered.add(nativeSessionId);
                rememberHistoricalQuestions(snapshot, seenQuestions);
                hydrateControls(snapshot, active, shells, endedTurns);
              }
            }
          }
        }
        if (
          thread &&
          (known.has(thread) || reading.has(thread)) &&
          ["turn/started", "turn/completed", "item/started", "item/completed"].includes(method)
        )
          revisions.set(thread, (revisions.get(thread) ?? 0) + 1);
      }
      if (dir === "recv" && method === "turn/completed" && thread === nativeSessionId)
        emit("note", {
          event: "discovery-start",
          threadId: thread,
          task: `discovery:${str(obj(p["turn"])["id"])}`,
        });
      if (dir === "send" && method === "thread/read") {
        scopedReads.add(m["id"]);
      }
      if (dir === "send" && method === "thread/turns/list") historyReplies.add(m["id"]);
      const scoped = dir === "recv" && scopedReads.delete(m["id"]);
      const history = dir === "recv" && (historyReplies.delete(m["id"]) || scoped);
      emit(
        dir,
        // History replies grow with the thread; their turns are recorded as bounded notes.
        history ? compactHistoryReply(m) : data,
        scoped ? "codex-discovery" : history ? "codex-history" : "stdio",
        optionalFrames.method(dir, data),
      );
      if (dir !== "recv") return;
      if (thread && !known.has(thread) && !timers.has(thread) && timers.size < 256)
        scheduleRecovery(thread);
      if (method === "turn/started") active.set(thread, str(obj(p["turn"])["id"]));
      if (method === "turn/completed") {
        const turn = str(obj(p["turn"])["id"]);
        if (active.get(thread) === turn) active.delete(thread);
        for (const [key, entry] of pending)
          if (
            obj(entry.request.params)["threadId"] === thread &&
            obj(entry.request.params)["turnId"] === turn
          ) {
            pending.delete(key);
            entry.reject(new Error("Turn ended before interaction was answered"));
          }
      }
      if (method === "serverRequest/resolved") {
        const key = interactionKey(p["requestId"]);
        const entry = pending.get(key);
        pending.delete(key);
        entry?.reject(new Error("Interaction resolved on another connection"));
      }
      if (method === "item/commandExecution/outputDelta" && !completedShells.has(str(p["itemId"])))
        shells.set(str(p["itemId"]), thread);
      if (method === "item/started" || method === "item/completed") {
        const item = obj(p["item"]);
        const id = str(item["id"]);
        if (item["type"] === "collabAgentToolCall" && item["tool"] === "spawnAgent")
          for (const receiver of list(item["receiverThreadIds"])) {
            const child = str(receiver);
            if (child) {
              known.add(child);
              parents.set(child, thread);
              if (!recovered.has(child)) scheduleRecovery(child);
            }
          }
        if (item["type"] === "subAgentActivity" && item["kind"] === "started") {
          const child = str(item["agentThreadId"]);
          if (child) {
            known.add(child);
            parents.set(child, thread);
            if (!recovered.has(child)) scheduleRecovery(child);
          }
        }
        if (item["type"] === "commandExecution") {
          if (method === "item/started") shells.set(id, thread);
          else {
            shells.delete(id);
            completedShells.add(id);
            if (completedShells.size > 1024) {
              const first = completedShells.values().next().value;
              if (first) completedShells.delete(first);
            }
          }
        }
        if (id && isAsyncQuestion(item) && !seenQuestions.has(id)) {
          seenQuestions.add(id);
          asyncQuestions.set(asyncKey(id), {
            thread,
            questions: questions(item["questions"], true),
          });
        }
        if (
          item["type"] === "plan" &&
          method === "item/completed" &&
          active.get(thread) === str(p["turnId"])
        )
          plans.set(planKey(str(p["turnId"])), { thread, markdown: str(item["text"]) });
      }
    },
    dropped(line) {
      emit("note", { event: "output-line-dropped", ...line });
    },
    outputUncertain: () => invalidateOutput(),
    malformed: (line) => emit("recv", { malformed: line }),
    error: diagnostic,
    notification: (message) => onNotification(message),
    request: (message) => onRequest(message),
    stderr: (line) => lifetime.stderr(line),
    failed: () => void lifetime.failTransport(),
    exited: (exit) => lifetime.exited(exit),
  };
  const rpc: Pick<CodexChannel, "request"> = {
    request: (method, params, requestOptions) =>
      link
        ? link.request(method, params, requestOptions)
        : Promise.reject(new Error("Codex session is not attached")),
  };
  const request = (method: string, params: unknown, interactive = false) =>
    rpc.request(method, params, { timeoutMs: interactive ? null : 30_000, signal: ctx.signal });
  const {
    scheduleRecovery,
    reconcileLoaded,
    refreshQueue,
    observeRecovery,
    readThread,
    invalidateOutput,
    isOutputUncertain,
  } = sessionDiscovery({
    request,
    emit,
    diagnostic,
    schedule: io.schedule,
    isClosed: () => closed,
    isForeign: (thread) => link?.foreign(thread) ?? false,
    getRoot: () => nativeSessionId,
    known,
    recovered,
    parents,
    active,
    shells,
    reading,
    revisions,
    timers,
    seenQuestions,
    endedTurns,
  });
  const catalog = createExtensionCatalog(
    rpc,
    ctx.cwd,
    ctx.signal,
    () => closed,
    () => nativeSessionId,
    (data) => emit("note", data, "catalog.runtime"),
  );
  function onNotification({ method, params }: Notification): void {
    catalog.changed(method, params);
    if (method === "turn/completed" && obj(params)["threadId"] === nativeSessionId)
      void reconcileLoaded(`discovery:${str(obj(obj(params)["turn"])["id"])}`);
    if (method === "thread/queue/changed")
      void refreshQueue(str(obj(params)["threadId"])).catch(diagnostic);
  }
  function onRequest(serverRequest: ServerRequest): Promise<unknown> {
    if (!isInteractiveRequest(serverRequest.method))
      throw new MethodNotFound(`Unsupported Codex request: ${serverRequest.method}`);
    return new Promise((answer, reject) =>
      pending.set(interactionKey(serverRequest.id), { request: serverRequest, answer, reject }),
    );
  }
  const lifetime = sessionLifetime({
    ctx,
    generation: scope,
    emit,
    closing() {
      closed = true;
    },
    busy: () => active.size > 0 || shells.size > 0 || isOutputUncertain(),
    // Closing often follows the session's own cancellation, so stop requests cannot carry its
    // signal. They are bounded instead; an unconfirmed stop retires the process.
    stopWork: () => {
      if (isOutputUncertain())
        return Promise.reject(new Error("Codex work has unrecovered controls"));
      return commandsFor(
        nativeSessionId,
        () => {},
        (method, params) => rpc.request(method, params, { timeoutMs: 10_000 }),
      ).interrupt({ agent: "root", cascade: true });
    },
    cleanup() {
      closed = true;
      for (const cancel of correlationDeadlines.values()) cancel();
      correlationDeadlines.clear();
      controlRequests.clear();
      optionalFrames.clear();
      for (const cancel of timers.values()) cancel();
      timers.clear();
      for (const entry of pending.values()) entry.reject(new Error("Codex session ended"));
      pending.clear();
      asyncQuestions.clear();
      plans.clear();
    },
  });
  emit("note", { event: "session-scope", scope });
  try {
    link = await openChannel({
      ctx,
      io,
      ...(options.discovery ? { discovery: options.discovery } : {}),
      ...(options.cli ? { cli: options.cli } : {}),
      ...(options.runtime?.discover ? { discoverAll: true } : {}),
      ...(options.hosts ? { pool: options.hosts } : {}),
      handlers,
    });
  } catch (error) {
    await lifetime.failOpen();
    throw error;
  }
  lifetime.attached(link);
  try {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    try {
      const listing = z
        .object({
          data: z
            .array(
              z.object({
                id: z.string().min(1).max(256),
                description: z.string().max(2048).nullish(),
                allowed: z.boolean(),
              }),
            )
            .max(256),
        })
        .parse(await request("permissionProfile/list", { cwd: ctx.cwd, limit: 256 }));
      const builtins = nativePermissionModes("codex");
      const permissionModes = listing.data
        .filter((profile) => profile.allowed)
        .map<import("@ace/protocol").NativePermissionMode>((profile) => ({
          id: profile.id,
          label: builtins.find((mode) => mode.id === profile.id)?.label ?? profile.id,
          description: profile.description ?? "",
          risk: builtins.find((mode) => mode.id === profile.id)?.risk ?? ("medium" as const),
          presentation: builtins.find((mode) => mode.id === profile.id)?.presentation,
        }));
      if (permissionModes.some((mode) => mode.id === ":workspace"))
        permissionModes.push(...builtins.filter((mode) => mode.id.startsWith("{")));
      const capabilities = codexCapabilities({
        installed: true,
        version: "0.159.1",
        auth: "unknown",
        loginHint: "",
      });
      const allowed = listing.data.filter((profile) => profile.allowed).map((p) => p.id);
      ctx.onCapabilities?.({
        ...capabilities,
        permissionModes,
        accessModes: accessModeOffers({ provider: "codex" }, codexAccessAvailable(allowed)),
        permissions: {
          modes: permissionModes.map((mode) => mode.id),
          permissionModes,
          nativeAutoReview: true,
          toolGate: true,
        },
      });
    } catch (error) {
      // Older experimental servers lack the profile catalog; preserve native startup policy.
      if (ctx.signal.aborted) throw error;
    }
    const threadPolicy: Pick<
      ThreadStartParams,
      "permissions" | "approvalPolicy" | "approvalsReviewer" | "config"
    > =
      permissionMode === null && ctx.resetPermissions
        ? configuredTurnPolicy(await request("config/read", { cwd: ctx.cwd, includeLayers: false }))
        : codexThreadPolicy(permissionMode, ctx.cwd);
    const params = {
      cwd: ctx.cwd,
      ...threadPolicy,
      ...(injection
        ? {
            developerInstructions: injection.developerInstructions,
            config: { ...threadPolicy.config, ...injection.config },
          }
        : {}),
      ...(ctx.model ? { model: ctx.model } : {}),
    } satisfies ThreadStartParams;
    const result = obj(
      await request(
        ctx.fork ? "thread/fork" : ctx.resume ? "thread/resume" : "thread/start",
        ctx.fork
          ? {
              ...params,
              threadId: ctx.fork.nativeSessionId,
              ...(ctx.fork.point.type === "turn" ? { lastTurnId: ctx.fork.point.nativeId } : {}),
              excludeTurns: true,
              deferGoalContinuation: true,
            }
          : ctx.resume
            ? ({
                ...params,
                threadId: ctx.resume.nativeSessionId,
                excludeTurns: true,
              } satisfies ThreadResumeParams)
            : params,
      ),
    );
    nativeSessionId = str(obj(result["thread"])["id"]);
    if (!nativeSessionId) throw new Error("Codex did not return a thread id");
    known.add(nativeSessionId);
    // An existing thread's history, in bounded pages, before anything can act on it.
    if (ctx.fork || ctx.resume) await readThread(nativeSessionId);

    model = str(result["model"], model);
    if (ctx.options !== undefined)
      await request("thread/settings/update", {
        threadId: nativeSessionId,
        effort: null,
        summary: null,
        serviceTier: null,
        ...selectedOptions,
      });
  } catch (error) {
    await lifetime.failOpen();
    throw error;
  }
  /** Session controls for a root thread. Closing reuses them with no open-state check. */
  function commandsFor(
    root: string,
    check: () => void,
    send: (method: string, params: unknown, interactive?: boolean) => Promise<unknown> = request,
  ) {
    return createSessionCommands({
      nativeSessionId: root,
      getLaunchOptions: async (_threadId) => {
        if (ctx.getPermissionMode) permissionMode = await ctx.getPermissionMode();
        const mode = permissionMode;
        const policy =
          mode === null && appliedPermissionMode !== null
            ? configuredTurnPolicy(
                await request("config/read", { cwd: ctx.cwd, includeLayers: false }),
              )
            : codexTurnPolicy(mode, ctx.cwd);
        return {
          mode,
          options: {
            ...policy,
            ...(selectedOptions.effort !== undefined ? { effort: selectedOptions.effort } : {}),
            ...(selectedOptions.serviceTier !== undefined
              ? { serviceTier: selectedOptions.serviceTier }
              : {}),
          },
        };
      },
      active,
      parents,
      shells,
      pending,
      asyncQuestions,
      interactionId: ctx.interactionId,
      plans,
      assertOpen: check,
      request: send,
      emit: (dir, data, channel) => {
        emit(dir, data, channel);
      },
      getModel: () => model,
      userMessageId: io.userMessageId,
      onInputMessage: ctx.onInputMessage,
      refreshQueue,
    });
  }
  function assertOpen(): void {
    if (closed) throw new Error("Codex session is closed");
  }
  catalog.start();
  emit("note", { event: "permission-turn-policy-supported" });
  readRateLimits({ request, emit, isClosed: () => closed });
  return {
    nativeSessionId,
    async configure(selection) {
      const executionOptions = CodexSelectionOptions.parse(selection.options);
      assertOpen();
      await request("thread/settings/update", {
        threadId: nativeSessionId,
        model: selection.model ?? null,
        effort: null,
        summary: null,
        serviceTier: null,
        ...executionOptions,
      });
      model = selection.model ?? "";
      selectedOptions = executionOptions;
    },
    close: lifetime.close,
    mcp: codexMcpControls(request, nativeSessionId, ctx.signal),
    ...commandsFor(nativeSessionId, assertOpen),
  };
}
