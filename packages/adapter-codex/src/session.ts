import { randomUUID } from "node:crypto";
import type { Key } from "@ace/core";
import type { ProviderSession, SessionContext } from "@ace/engine-api";
import type { ContentPart, InteractionResolution } from "@ace/protocol";
import {
  discoverProviders,
  type DiscoveryOptions,
  type DiscoveryResult,
} from "@ace/provider-kit/discovery";
import { JsonRpcPeer, MethodNotFound, type ServerRequest } from "@ace/provider-kit/jsonrpc";
import { spawnSupervised } from "@ace/provider-kit/process";
import type { InitializeParams } from "./generated/InitializeParams.ts";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.ts";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts";
import type { ThreadQueueAddParams } from "./generated/v2/ThreadQueueAddParams.ts";
import { codexCapabilities } from "./capabilities.ts";
import { asyncKey, childKey, list, obj, planKey, requestKey, shellKey, str } from "./native.ts";
import { approvalResult } from "./resolution.ts";

type Pending = { request: ServerRequest; answer(value: unknown): void; reject(error: Error): void };
export type CodexOptions = { discovery?: DiscoveryOptions; cli?: DiscoveryResult };
function input(parts: ContentPart[]): TurnStartParams["input"] {
  return parts.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text, text_elements: [] }
      : part.type === "image"
        ? { type: "image", url: part.url }
        : { type: "mention", name: part.path.split("/").at(-1) ?? part.path, path: part.path },
  );
}

export async function openCodexSession(
  ctx: SessionContext,
  options: CodexOptions = {},
): Promise<ProviderSession> {
  if (ctx.signal.aborted) throw ctx.signal.reason;
  const cli = options.cli ?? (await discoverProviders(options.discovery)).codex;
  if (!cli.installed || !cli.path)
    throw new Error("Codex is not installed. Install it or configure its path.");
  if (!codexCapabilities(cli).steer)
    throw new Error(
      `Codex ${cli.version ?? "unknown version"} is unsupported; need 0.159.1 or newer.`,
    );
  const proc = spawnSupervised({
    command: cli.path,
    args: ["app-server"],
    cwd: ctx.cwd,
    env: options.discovery?.env ?? {},
    name: "ace-codex",
  });
  const started = performance.now();
  let sequence = 0;
  let nativeSessionId = "";
  let model = ctx.model ?? "";
  let deliberate = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const active = new Map<string, string>();
  const parents = new Map<string, string>();
  const known = new Set<string>();
  const shells = new Map<string, string>();
  const pending = new Map<string, Pending>();
  const asyncQuestions = new Map<string, string>();
  const plans = new Map<string, { thread: string; markdown: string }>();
  const mode = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const emit = (dir: "send" | "recv" | "stderr" | "note", data: unknown, channel = "stdio") =>
    ctx.onFrame({
      seq: sequence++,
      t: Math.round(performance.now() - started),
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
        emit("note", { event: "discovery-start", threadId: thread });
      emit(dir, data);
      if (dir !== "recv") return;
      if (thread && !known.has(thread) && !timers.has(thread))
        timers.set(
          thread,
          setTimeout(() => {
            timers.delete(thread);
            if (!closed && !known.has(thread)) void readThread(thread).catch(diagnostic);
          }, 2_000),
        );
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
        const key = requestKey(p["requestId"]);
        const entry = pending.get(key);
        pending.delete(key);
        entry?.reject(new Error("Interaction resolved on another connection"));
      }
      if (method === "thread/settings/updated")
        mode.set(thread, str(obj(p["collaborationMode"])["mode"]));
      if (method === "item/started" || method === "item/completed") {
        const item = obj(p["item"]);
        const id = str(item["id"]);
        if (item["type"] === "subAgentActivity" && item["kind"] === "started") {
          const child = str(item["agentThreadId"]);
          known.add(child);
          parents.set(child, thread);
          clearTimeout(timers.get(child));
          timers.delete(child);
        }
        if (item["type"] === "commandExecution") {
          if (method === "item/started") shells.set(id, thread);
          else shells.delete(id);
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
  async function readThread(threadId: string): Promise<void> {
    const result = obj(await request("thread/read", { threadId, includeTurns: true }));
    const thread = obj(result["thread"]);
    const parent = str(
      thread["parentThreadId"],
      str(obj(obj(obj(thread["source"])["subAgent"])["thread_spawn"])["parent_thread_id"]),
    );
    known.add(threadId);
    if (parent) parents.set(threadId, parent);
    for (const turn of list(thread["turns"]))
      if (obj(turn)["status"] === "inProgress") active.set(threadId, str(obj(turn)["id"]));
  }
  async function reconcileLoaded(): Promise<void> {
    try {
      let cursor: unknown = undefined;
      do {
        const result = obj(await request("thread/loaded/list", { ...(cursor ? { cursor } : {}) }));
        for (const entry of list(result["data"]))
          if (typeof entry === "string" && !known.has(entry)) await readThread(entry);
        cursor = result["nextCursor"];
      } while (cursor);
    } catch (error) {
      diagnostic(error);
    } finally {
      if (!closed) emit("note", { event: "discovery-finished", threadId: nativeSessionId });
    }
  }
  rpc.onNotification = ({ method, params }) => {
    if (method === "turn/completed" && obj(params)["threadId"] === nativeSessionId)
      void reconcileLoaded();
  };
  rpc.onRequest = (request) => {
    if (
      !request.method.endsWith("requestApproval") &&
      request.method !== "item/tool/requestUserInput" &&
      request.method !== "mcpServer/elicitation/request"
    )
      throw new MethodNotFound(`Unsupported Codex request: ${request.method}`);
    return new Promise((answer, reject) =>
      pending.set(requestKey(request.id), { request, answer, reject }),
    );
  };
  proc.stderr.on("line", (line) => emit("stderr", line));
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    deliberate = true;
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
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
    for (const timer of timers.values()) clearTimeout(timer);
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
    model = str(result["model"], model);
  } catch (error) {
    await close();
    throw error;
  }
  function assertOpen(): void {
    if (closed) throw new Error("Codex session is closed");
  }
  async function sendTo(
    threadId: string,
    parts: ContentPart[],
    delivery: "steer" | "queue",
  ): Promise<void> {
    assertOpen();
    const turn = active.get(threadId);
    if (turn && delivery === "queue")
      await request("thread/queue/add", {
        threadId,
        input: input(parts),
        clientUserMessageId: randomUUID(),
      } satisfies ThreadQueueAddParams);
    else if (turn)
      await request(
        "turn/steer",
        { threadId, expectedTurnId: turn, input: input(parts) } satisfies TurnSteerParams,
        true,
      );
    else {
      const result = obj(
        await request(
          "turn/start",
          { threadId, input: input(parts) } satisfies TurnStartParams,
          true,
        ),
      );
      const id = str(obj(result["turn"])["id"]);
      if (id) active.set(threadId, id);
    }
  }
  async function stopShells(threadId: string, itemId?: string): Promise<void> {
    let cursor: unknown = undefined;
    const processIds: string[] = [];
    do {
      const result = obj(
        await request("thread/backgroundTerminals/list", {
          threadId,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const terminal of list(result["data"])) {
        const t = obj(terminal);
        if (!itemId || t["itemId"] === itemId) processIds.push(str(t["processId"]));
      }
      cursor = result["nextCursor"];
    } while (cursor);
    if (itemId && !processIds.length) throw new Error("Background terminal is no longer listed");
    for (const processId of processIds)
      await request("thread/backgroundTerminals/terminate", { threadId, processId }, true);
  }
  async function interruptOne(thread: string, cascade: boolean): Promise<void> {
    const turnId = active.get(thread);
    if (turnId) await request("turn/interrupt", { threadId: thread, turnId }, true);
    if (cascade) await stopShells(thread);
  }
  return {
    nativeSessionId,
    send: (parts, delivery) => sendTo(nativeSessionId, parts, delivery),
    async interrupt(target) {
      assertOpen();
      const thread = !target.agent || target.agent === "root" ? nativeSessionId : target.agent;
      const targets = new Set([thread]);
      if (target.cascade)
        for (const [child] of parents) {
          let parent = parents.get(child);
          const seen = new Set<string>();
          while (parent && !seen.has(parent)) {
            if (parent === thread) {
              targets.add(child);
              break;
            }
            seen.add(parent);
            parent = parents.get(parent);
          }
        }
      for (const id of targets) await interruptOne(id, target.cascade);
    },
    async stopTask(task: Key) {
      assertOpen();
      if (task.startsWith("subagent:")) {
        await interruptOne(task.slice(childKey("").length), true);
        return;
      }
      const item = task.startsWith("shell:") ? task.slice(shellKey("").length) : task;
      const thread = shells.get(item);
      if (!thread) throw new Error("Unknown Codex background task");
      await stopShells(thread, item);
    },
    async resolve(key, resolution) {
      assertOpen();
      const entry = pending.get(key);
      if (entry) {
        const result = approvalResult(entry.request, resolution);
        pending.delete(key);
        entry.answer(result);
        return;
      }
      const thread = asyncQuestions.get(key);
      if (thread && resolution.kind === "question") {
        const text = resolution.dismissed
          ? "Continue without answers."
          : Object.values(resolution.answers)
              .map((answers) => answers.join(", "))
              .join("; ");
        await sendTo(thread, [{ type: "text", text }], "steer");
        asyncQuestions.delete(key);
        emit("note", { event: "interaction-resolved", interaction: key });
        return;
      }
      const plan = plans.get(key);
      if (plan && resolution.kind === "plan_review") {
        if (
          resolution.decision !== "cancel" &&
          (resolution.decision === "approve" || resolution.feedback)
        )
          await request(
            "turn/start",
            {
              threadId: plan.thread,
              input: input([
                {
                  type: "text",
                  text:
                    resolution.decision === "approve"
                      ? "Implement the plan."
                      : resolution.feedback!,
                },
              ]),
              collaborationMode: {
                mode: resolution.decision === "approve" ? "default" : "plan",
                settings: { model, reasoning_effort: null, developer_instructions: null },
              },
            } satisfies TurnStartParams,
            true,
          );
        plans.delete(key);
        emit("note", { event: "interaction-resolved", interaction: key });
        return;
      }
      throw new Error("Unknown or already resolved Codex interaction");
    },
    close,
  };
}
