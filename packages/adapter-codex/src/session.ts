import { isAsyncQuestion, rememberHistoricalQuestions } from "./interaction-lifecycle.ts";
import { turnPolicyState } from "./turn-policy-state.ts";
import { PermissionMode } from "@ace/protocol";
import { codexInjection, redactMcpCredential } from "@ace/mcp-server";
import { codexThreadPolicy, codexTurnPolicy } from "./permission-policy.ts";
import { CodexSelectionOptions } from "./selection.ts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { isInteractiveRequest } from "./interactions.ts";
import { runtime, type CodexRuntime } from "./runtime.ts";
import { hydrateControls, parentOf } from "./session-state.ts";
import type { ProviderSession } from "@ace/engine-api";
import type { CodexSessionContext } from "./session-context.ts";
import { type DiscoveryOptions, type DiscoveryResult } from "@ace/provider-kit/discovery";
import { JsonRpcPeer, MethodNotFound } from "@ace/provider-kit/jsonrpc";
import type { InitializeParams } from "./generated/InitializeParams.ts";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts";
import { createSessionCommands, type Pending } from "./session-commands.ts";
import { codexCapabilities } from "./capabilities.ts";
import { asyncKey, list, obj, planKey, questions, requestKey, str } from "./native.ts";

export type CodexOptions = {
  discovery?: DiscoveryOptions;
  cli?: DiscoveryResult;
  runtime?: Partial<CodexRuntime>;
};
export async function openCodexSession(
  ctx: CodexSessionContext,
  options: CodexOptions = {},
): Promise<ProviderSession> {
  let permissionMode = ctx.permissionMode ?? "auto-review";
  const policies = turnPolicyState(permissionMode);
  let selectedOptions = CodexSelectionOptions.parse(ctx.options ?? {});
  if (ctx.fork && ctx.resume) throw new Error("Fork and resume are exclusive");
  if (ctx.fork?.point.type === "item")
    throw new Error("Codex supports native turn boundaries only");
  if (ctx.signal.aborted) throw ctx.signal.reason;
  const io = { ...runtime, ...options.runtime };
  const scope = io.sessionId();
  const interactionKey = (id: unknown) => requestKey(id, scope);
  const seenQuestions = new Set<string>();
  const cli =
    options.cli ??
    (await io.discover({ ...options.discovery, ...(ctx.env ? { env: ctx.env } : {}) })).codex;
  if (!cli.installed || !cli.path)
    throw new Error("Codex is not installed. Install it or configure its path.");
  if (!codexCapabilities(cli).steer)
    throw new Error(
      `Codex ${cli.version ?? "unknown version"} is unsupported; need 0.159.1 or newer.`,
    );
  const injection = ctx.aceMcp ? codexInjection(ctx.aceMcp) : undefined;
  const proc = io.spawn({
    command: cli.path,
    args: ["app-server", ...(injection?.args ?? [])],
    cwd: ctx.cwd,
    ...(ctx.outputFlow ? { outputFlow: ctx.outputFlow } : {}),
    env: { ...(ctx.env ?? options.discovery?.env), ...injection?.env },
    name: "ace-codex",
  });
  const started = io.now();
  let sequence = 0;
  let nativeSessionId = "";
  let model = ctx.model ?? "";
  let deliberate = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const active = new Map<string, string>();
  const controlRequests = new Map<
    unknown,
    { method: string; thread: string; mode: PermissionMode }
  >();
  const revisions = new Map<string, number>();
  const readRevisions = new Map<string, number>();
  const scopedReads = new Set<unknown>();
  const parents = new Map<string, string>();
  const known = new Set<string>();
  // Confirmed ancestry does not prove that retained history is complete.
  const recovered = new Set<string>();
  const shells = new Map<string, string>();
  const completedShells = new Set<string>();
  const pending = new Map<string, Pending>();
  const asyncQuestions: import("./session-commands.ts").SessionCommandsContext["asyncQuestions"] =
    new Map();
  const plans = new Map<string, { thread: string; markdown: string }>();
  const queueCounts = new Map<string, number>();
  const timers = new Map<string, () => void>();
  const recovering = new Set<string>();
  let unknownRecoveries = 0;
  const emit = (dir: "send" | "recv" | "stderr" | "note", data: unknown, channel = "stdio") => {
    const payload = new ProviderPayload(redactMcpCredential(JSON.stringify(data), ctx.aceMcp));
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
  const rpc = new JsonRpcPeer(proc, {
    timeoutMs: null,
    onFrame(dir, data) {
      const m = obj(data);
      const p = obj(m["params"]);
      const method = str(m["method"]);
      const thread = str(p["threadId"]);
      if (dir === "send" && method === "turn/start") policies.sent(m["id"], thread);
      if (
        dir === "send" &&
        ["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(method)
      )
        controlRequests.set(m["id"], { method, thread, mode: permissionMode });
      if (dir === "recv") {
        const control = controlRequests.get(m["id"]);
        controlRequests.delete(m["id"]);
        const result = obj(m["result"]);
        const snapshot = obj(result["thread"]);
        if (control && m["error"] === undefined) {
          if (control.method === "turn/start") {
            const id = str(obj(result["turn"])["id"]);
            policies.reply(m["id"], id);
            if (id) active.set(control.thread, id);
            if (id && control.thread === nativeSessionId)
              emit("note", { event: "permission-mode-applied", mode: control.mode });
          } else {
            nativeSessionId = str(snapshot["id"]);
            if (nativeSessionId) {
              policies.root(nativeSessionId);
              known.add(nativeSessionId);
              if (Array.isArray(snapshot["turns"])) recovered.add(nativeSessionId);
              rememberHistoricalQuestions(snapshot, seenQuestions);
              hydrateControls(snapshot, active, shells);
            }
          }
        }
        if (control?.method === "turn/start" && m["error"] !== undefined)
          policies.reply(m["id"], "");
        policies.observe(method, p);
        if (isInteractiveRequest(method) && m["id"] !== undefined)
          emit("note", {
            event: "permission-review-policy",
            interaction: interactionKey(m["id"]),
            mode: policies.policy(thread, str(p["turnId"]), str(p["itemId"])),
          });
        if (scopedReads.has(m["id"]) && str(snapshot["id"]))
          readRevisions.set(str(snapshot["id"]), revisions.get(str(snapshot["id"])) ?? 0);
        if (
          thread &&
          (known.has(thread) || readRevisions.has(thread)) &&
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
      if (dir === "send" && method === "thread/read") scopedReads.add(m["id"]);
      const scoped = dir === "recv" && scopedReads.delete(m["id"]);
      emit(dir, data, scoped ? "codex-discovery" : "stdio");
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
        if (isAsyncQuestion(item) && !seenQuestions.has(id)) {
          seenQuestions.add(id);
          asyncQuestions.set(asyncKey(id), {
            thread,
            questions: questions(item["questions"], true),
          });
        }
        if (item["type"] === "plan" && method === "item/completed")
          plans.set(planKey(str(p["turnId"])), { thread, markdown: str(item["text"]) });
      }
    },
    onMalformed: (line) => emit("recv", { malformed: line }),
    onError: diagnostic,
  });
  const request = (method: string, params: unknown, interactive = false) =>
    rpc.request(method, params, { timeoutMs: interactive ? null : 30_000, signal: ctx.signal });
  function scheduleRecovery(threadId: string): void {
    if (closed || timers.has(threadId)) return;
    timers.set(
      threadId,
      io.schedule(() => {
        timers.delete(threadId);
        if (!closed) void recoverThread(threadId);
      }, 2_000),
    );
  }
  async function recoverThread(threadId: string): Promise<void> {
    if (recovering.has(threadId) || recovered.has(threadId) || closed) return;
    const unknown = !known.has(threadId);
    // Reserve capacity for admitted children and control commands. A saturated
    // unknown-thread timer batch must not exhaust the peer's bounded RPC queue.
    if (recovering.size >= 8 || (unknown && unknownRecoveries >= 4)) {
      scheduleRecovery(threadId);
      return;
    }
    recovering.add(threadId);
    if (unknown) unknownRecoveries++;
    try {
      await readThread(threadId);
    } catch (error) {
      diagnostic(error);
      scheduleRecovery(threadId);
    } finally {
      recovering.delete(threadId);
      if (unknown) unknownRecoveries--;
    }
  }
  async function readThread(threadId: string, ancestors = new Set<string>()): Promise<void> {
    if (ancestors.has(threadId)) throw new Error("Cyclic Codex thread ancestry");
    ancestors.add(threadId);
    const result = obj(await request("thread/read", { threadId, includeTurns: true }));
    const thread = obj(result["thread"]);
    if (str(thread["id"]) !== threadId)
      throw new Error("Codex thread read returned a different id");
    const parent = parentOf(thread);
    if (parent && !known.has(parent)) await readThread(parent, ancestors);
    if (threadId !== nativeSessionId && (!parent || !known.has(parent))) {
      readRevisions.delete(threadId);
      revisions.delete(threadId);
      return;
    }
    if (!Array.isArray(thread["turns"])) throw new Error("Codex read omitted turn history");
    known.add(threadId);
    recovered.add(threadId);
    timers.get(threadId)?.();
    timers.delete(threadId);
    if (parent) parents.set(threadId, parent);
    const revision = readRevisions.get(threadId);
    readRevisions.delete(threadId);
    if (revision === (revisions.get(threadId) ?? 0)) hydrateControls(thread, active, shells);
    rememberHistoricalQuestions(thread, seenQuestions);
    emit("note", { event: "thread-discovered", thread });
  }
  async function refreshQueue(threadId: string): Promise<void> {
    let cursor: unknown = undefined;
    let count = 0;
    do {
      const result = obj(
        await request("thread/queue/list", { threadId, ...(cursor ? { cursor } : {}) }),
      );
      count += list(result["data"]).length;
      cursor = result["nextCursor"];
    } while (cursor);
    queueCounts.set(threadId, count);
    emit("note", {
      event: "queue-state",
      count: [...queueCounts.values()].reduce((total, value) => total + value, 0),
    });
  }
  async function reconcileLoaded(task: string): Promise<void> {
    try {
      let cursor: unknown = undefined;
      do {
        const result = obj(await request("thread/loaded/list", cursor ? { cursor } : {}));
        for (const entry of list(result["data"]))
          if (typeof entry === "string" && !recovered.has(entry)) await readThread(entry);
        cursor = result["nextCursor"];
      } while (cursor);
      if (!closed) emit("note", { event: "discovery-finished", threadId: nativeSessionId, task });
    } catch (error) {
      diagnostic(error);
      if (!closed && !timers.has(task))
        timers.set(
          task,
          io.schedule(() => {
            timers.delete(task);
            if (!closed) void reconcileLoaded(task);
          }, 2_000),
        );
    }
  }
  rpc.onNotification = ({ method, params }) => {
    if (method === "turn/completed" && obj(params)["threadId"] === nativeSessionId)
      void reconcileLoaded(`discovery:${str(obj(obj(params)["turn"])["id"])}`);
    if (method === "thread/queue/changed")
      void refreshQueue(str(obj(params)["threadId"])).catch(diagnostic);
  };
  rpc.onRequest = (serverRequest) => {
    if (!isInteractiveRequest(serverRequest.method))
      throw new MethodNotFound(`Unsupported Codex request: ${serverRequest.method}`);
    return new Promise((answer, reject) =>
      pending.set(interactionKey(serverRequest.id), { request: serverRequest, answer, reject }),
    );
  };
  proc.stderr.on("line", (line) => emit("stderr", line));
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    deliberate = true;
    closed = true;
    for (const cancel of timers.values()) cancel();
    timers.clear();
    for (const entry of pending.values()) entry.reject(new Error("Codex session closed"));
    pending.clear();
    rpc.close();
    ctx.signal.removeEventListener("abort", abort);
    closePromise = proc.stop({ graceMs: io.stopGraceMs }).then(() => {});
    return closePromise;
  };
  const abort = () => {
    void close();
  };
  ctx.signal.addEventListener("abort", abort, { once: true });
  void proc.exited.then((exit) => {
    closed = true;
    for (const cancel of timers.values()) cancel();
    for (const entry of pending.values()) entry.reject(new Error("Codex process exited"));
    pending.clear();
    ctx.signal.removeEventListener("abort", abort);
    ctx.onExit({ deliberate, message: `Codex process ${exit.reason}, code ${exit.code}` });
  });
  emit("note", { event: "session-scope", scope });
  try {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    await request("initialize", {
      clientInfo: { name: "ace", title: "ace", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    } satisfies InitializeParams);
    rpc.notify("initialized");
    const params = {
      cwd: ctx.cwd,
      ...codexThreadPolicy(permissionMode, ctx.cwd),
      ...(injection ? { developerInstructions: injection.developerInstructions } : {}),
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
            ? ({ ...params, threadId: ctx.resume.nativeSessionId } satisfies ThreadResumeParams)
            : params,
      ),
    );
    nativeSessionId = str(obj(result["thread"])["id"]);
    if (!nativeSessionId) throw new Error("Codex did not return a thread id");
    known.add(nativeSessionId);

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
    await close();
    throw error;
  }
  function assertOpen(): void {
    if (closed) throw new Error("Codex session is closed");
  }
  emit("note", { event: "permission-turn-policy-supported" });
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
    close,
    ...createSessionCommands({
      nativeSessionId,
      getLaunchOptions: async () => {
        permissionMode = (await ctx.getPermissionMode?.()) ?? permissionMode;
        return {
          mode: permissionMode,
          options: {
            ...codexTurnPolicy(permissionMode, ctx.cwd),
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
      assertOpen,
      request,
      emit: (dir, data, channel) => {
        const note = obj(data);
        if (dir === "note" && note["event"] === "permission-turn-submitting") {
          const mode = PermissionMode.parse(note["mode"]);
          permissionMode = mode;
          policies.submit(str(note["threadId"]), mode);
        }
        emit(dir, data, channel);
      },
      getModel: () => model,
      userMessageId: io.userMessageId,
      refreshQueue,
    }),
  };
}
