import { runtime, type CodexRuntime } from "./runtime.ts";
import { hydrateControls, parentOf } from "./session-state.ts";
import type { ProviderSession, SessionContext } from "@ace/engine-api";
import { type DiscoveryOptions, type DiscoveryResult } from "@ace/provider-kit/discovery";
import { JsonRpcPeer, MethodNotFound } from "@ace/provider-kit/jsonrpc";
import type { InitializeParams } from "./generated/InitializeParams.ts";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts";
import { createSessionCommands, type Pending } from "./session-commands.ts";
import { codexCapabilities } from "./capabilities.ts";
import { asyncKey, list, obj, planKey, requestKey, str } from "./native.ts";

export type CodexOptions = {
  discovery?: DiscoveryOptions;
  cli?: DiscoveryResult;
  runtime?: Partial<CodexRuntime>;
};
export async function openCodexSession(
  ctx: SessionContext,
  options: CodexOptions = {},
): Promise<ProviderSession> {
  if (ctx.signal.aborted) throw ctx.signal.reason;
  const io = { ...runtime, ...options.runtime };
  const cli = options.cli ?? (await io.discover(options.discovery)).codex;
  if (!cli.installed || !cli.path)
    throw new Error("Codex is not installed. Install it or configure its path.");
  if (!codexCapabilities(cli).steer)
    throw new Error(
      `Codex ${cli.version ?? "unknown version"} is unsupported; need 0.159.1 or newer.`,
    );
  const proc = io.spawn({
    command: cli.path,
    args: ["app-server"],
    cwd: ctx.cwd,
    env: options.discovery?.env ?? {},
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
  const ended = new Set<string>();
  const scopedReads = new Set<unknown>();
  const parents = new Map<string, string>();
  const known = new Set<string>();
  const shells = new Map<string, string>();
  const completedShells = new Set<string>();
  const pending = new Map<string, Pending>();
  const asyncQuestions = new Map<string, string>();
  const plans = new Map<string, { thread: string; markdown: string }>();
  const queueCounts = new Map<string, number>();
  const timers = new Map<string, () => void>();
  const emit = (dir: "send" | "recv" | "stderr" | "note", data: unknown, channel = "stdio") =>
    ctx.onFrame({
      seq: sequence++,
      t: Math.round(io.now() - started),
      dir,
      channel,
      data,
    });
  const diagnostic = (error: unknown) =>
    emit("stderr", error instanceof Error ? error.message : String(error));
  const rpc = new JsonRpcPeer(proc, {
    timeoutMs: null,
    onFrame(dir, data) {
      const m = obj(data);
      const p = obj(m["params"]);
      const method = str(m["method"]);
      const thread = str(p["threadId"]);
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
      if (thread && !known.has(thread) && !timers.has(thread))
        timers.set(
          thread,
          io.schedule(() => {
            timers.delete(thread);
            if (!closed) void readThread(thread).catch(diagnostic);
          }, 2_000),
        );
      if (method === "turn/started") active.set(thread, str(obj(p["turn"])["id"]));
      if (method === "turn/completed") {
        const turn = str(obj(p["turn"])["id"]);
        ended.add(turn);
        if (ended.size > 1024) {
          const first = ended.values().next().value;
          if (first) ended.delete(first);
        }
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
        const key = requestKey(p["requestId"]);
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
            }
          }
        if (item["type"] === "subAgentActivity" && item["kind"] === "started") {
          const child = str(item["agentThreadId"]);
          known.add(child);
          parents.set(child, thread);
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
        if (item["delivery"] === "async" && list(item["questions"]).length)
          asyncQuestions.set(asyncKey(id), thread);
        if (item["type"] === "plan" && method === "item/completed")
          plans.set(planKey(str(p["turnId"])), { thread, markdown: str(item["text"]) });
      }
    },
    onMalformed: (line) => emit("recv", { malformed: line }),
    onError: diagnostic,
  });
  const request = (method: string, params: unknown, interactive = false) =>
    rpc.request(method, params, { timeoutMs: interactive ? null : 30_000, signal: ctx.signal });
  async function readThread(threadId: string, ancestors = new Set<string>()): Promise<void> {
    if (ancestors.has(threadId)) throw new Error("Cyclic Codex thread ancestry");
    ancestors.add(threadId);
    const result = obj(await request("thread/read", { threadId, includeTurns: true }));
    const thread = obj(result["thread"]);
    if (str(thread["id"]) !== threadId)
      throw new Error("Codex thread read returned a different id");
    const parent = parentOf(thread);
    if (parent && !known.has(parent)) await readThread(parent, ancestors);
    if (threadId !== nativeSessionId && (!parent || !known.has(parent))) return;
    known.add(threadId);
    if (parent) parents.set(threadId, parent);
    hydrateControls(thread, active, shells);
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
          if (typeof entry === "string" && !known.has(entry)) await readThread(entry);
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
    if (
      !serverRequest.method.endsWith("requestApproval") &&
      serverRequest.method !== "item/tool/requestUserInput" &&
      serverRequest.method !== "mcpServer/elicitation/request"
    )
      throw new MethodNotFound(`Unsupported Codex request: ${serverRequest.method}`);
    return new Promise((answer, reject) =>
      pending.set(requestKey(serverRequest.id), { request: serverRequest, answer, reject }),
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
    closePromise = proc.stop().then(() => {});
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
  try {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    await request("initialize", {
      clientInfo: { name: "ace", title: "ace", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    } satisfies InitializeParams);
    rpc.notify("initialized");
    const params = {
      cwd: ctx.cwd,
      ...(ctx.model ? { model: ctx.model } : {}),
    } satisfies ThreadStartParams;
    const result = obj(
      await request(
        ctx.resume ? "thread/resume" : "thread/start",
        ctx.resume
          ? ({ ...params, threadId: ctx.resume.nativeSessionId } satisfies ThreadResumeParams)
          : params,
      ),
    );
    nativeSessionId = str(obj(result["thread"])["id"]);
    if (!nativeSessionId) throw new Error("Codex did not return a thread id");
    known.add(nativeSessionId);
    hydrateControls(obj(result["thread"]), active, shells);
    model = str(result["model"], model);
  } catch (error) {
    await close();
    throw error;
  }
  function assertOpen(): void {
    if (closed) throw new Error("Codex session is closed");
  }
  return {
    nativeSessionId,
    close,
    ...createSessionCommands({
      nativeSessionId,
      active,
      ended,
      parents,
      shells,
      pending,
      asyncQuestions,
      plans,
      assertOpen,
      request,
      emit,
      getModel: () => model,
      userMessageId: io.userMessageId,
      refreshQueue,
    }),
  };
}
