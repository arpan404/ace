import { z } from "zod";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import { codexCapabilities } from "./capabilities.ts";
import { sessionDiscovery } from "./session-discovery.ts";
import { sessionLifetime } from "./session-lifetime.ts";
import { isAsyncQuestion, rememberHistoricalQuestions } from "./interaction-lifecycle.ts";
import { codexInjection, redactMcpCredential } from "@ace/mcp-server";
import { codexThreadPolicy, codexTurnPolicy } from "./permission-policy.ts";
import { CodexSelectionOptions } from "./selection.ts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { isInteractiveRequest } from "./interactions.ts";
import { runtime, type CodexRuntime } from "./runtime.ts";
import { hydrateControls } from "./session-state.ts";
import type { ProviderSession } from "@ace/engine-api";
import type { CodexSessionContext } from "./session-context.ts";
import { type DiscoveryOptions, type DiscoveryResult } from "@ace/provider-kit/discovery";
import { JsonRpcPeer, MethodNotFound } from "@ace/provider-kit/jsonrpc";
import type { InitializeParams } from "./generated/InitializeParams.ts";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts";
import { createSessionCommands, type Pending } from "./session-commands.ts";
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
  let permissionMode = ctx.permissionMode ?? null;
  let selectedOptions = CodexSelectionOptions.parse(ctx.options ?? {});
  if (ctx.fork && ctx.resume) throw new Error("Fork and resume are exclusive");
  if (ctx.fork?.point.type === "item")
    throw new Error("Codex supports native turn boundaries only");
  if (ctx.signal.aborted) throw ctx.signal.reason;
  const io = { ...runtime, ...options.runtime };
  const scope = io.sessionId();
  const interactionKey = (id: unknown) => requestKey(id, scope);
  const seenQuestions = new Set<string>();
  const discovery = {
    ...options.discovery,
    ...(ctx.env ? { env: ctx.env } : {}),
    signal: ctx.signal,
  };
  const cli = ctx.executable
    ? await io.discoverProvider("codex", {
        ...discovery,
        overrides: { ...discovery.overrides, codex: ctx.executable },
      })
    : (options.cli ??
      (options.runtime?.discover
        ? (await io.discover(discovery)).codex
        : await io.discoverProvider("codex", discovery)));
  if (!cli.installed || !cli.path)
    throw new Error("Codex is not installed. Install it or configure its path.");
  if (!codexCapabilities(cli).steer)
    throw new Error(
      `Codex ${cli.version ?? "unknown version"} is unsupported; need 0.159.1 or newer.`,
    );
  const injection = ctx.aceMcp ? codexInjection(ctx.aceMcp) : undefined;
  const proc = io.spawn({
    command: cli.path,
    args: ["app-server"],
    cwd: ctx.cwd,
    ...(ctx.outputFlow ? { outputFlow: ctx.outputFlow } : {}),
    env: { ...(ctx.env ?? options.discovery?.env), ACE_MCP_BEARER_TOKEN: undefined },
    name: "ace-codex",
  });
  const started = io.now();
  let sequence = 0;
  let nativeSessionId = "";
  let model = ctx.model ?? "";
  let closed = false;
  const active = new Map<string, string>();
  const controlRequests = new Map<
    unknown,
    { method: string; thread: string; mode: string | null }
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
  const timers = new Map<string, () => void>();
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
      const submittedMode = permissionMode;
      if (
        dir === "send" &&
        ["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(method)
      )
        controlRequests.set(m["id"], { method, thread, mode: submittedMode });
      if (dir === "recv") {
        const control = method ? undefined : controlRequests.get(m["id"]);
        if (!method) controlRequests.delete(m["id"]);
        const result = obj(m["result"]);
        const snapshot = obj(result["thread"]);
        if (control && m["error"] === undefined) {
          if (control.method === "turn/start") {
            const id = str(obj(result["turn"])["id"]);
            if (id) active.set(control.thread, id);
            if (id && control.thread === nativeSessionId)
              emit("note", { event: "permission-mode-applied", mode: control.mode });
          } else {
            nativeSessionId = str(snapshot["id"]);
            if (nativeSessionId) {
              known.add(nativeSessionId);
              if (Array.isArray(snapshot["turns"])) recovered.add(nativeSessionId);
              rememberHistoricalQuestions(snapshot, seenQuestions);
              hydrateControls(snapshot, active, shells);
            }
          }
        }
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
    onMalformed: (line) => emit("recv", { malformed: line }),
    onError: diagnostic,
  });
  const request = (method: string, params: unknown, interactive = false) =>
    rpc.request(method, params, { timeoutMs: interactive ? null : 30_000, signal: ctx.signal });
  const { scheduleRecovery, reconcileLoaded, refreshQueue } = sessionDiscovery({
    request,
    emit,
    diagnostic,
    schedule: io.schedule,
    isClosed: () => closed,
    getRoot: () => nativeSessionId,
    known,
    recovered,
    parents,
    active,
    shells,
    readRevisions,
    revisions,
    timers,
    seenQuestions,
  });
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
  const lifetime = sessionLifetime({
    proc,
    ctx,
    generation: scope,
    graceMs: io.stopGraceMs,
    emit,
    cleanup() {
      closed = true;
      for (const cancel of timers.values()) cancel();
      timers.clear();
      for (const entry of pending.values()) entry.reject(new Error("Codex session ended"));
      pending.clear();
      asyncQuestions.clear();
      plans.clear();
      rpc.close();
    },
  });
  emit("note", { event: "session-scope", scope });
  try {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    await request("initialize", {
      clientInfo: { name: "ace", title: "ace", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    } satisfies InitializeParams);
    rpc.notify("initialized");
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
        .map((profile) => ({
          id: profile.id,
          label: builtins.find((mode) => mode.id === profile.id)?.label ?? profile.id,
          description: profile.description ?? "",
          risk: builtins.find((mode) => mode.id === profile.id)?.risk ?? ("medium" as const),
        }));
      if (permissionModes.some((mode) => mode.id === ":workspace"))
        permissionModes.push(...builtins.filter((mode) => mode.id.startsWith("{")));
      const capabilities = codexCapabilities({
        installed: true,
        version: "0.159.1",
        auth: "unknown",
        loginHint: "",
      });
      ctx.onCapabilities?.({
        ...capabilities,
        permissionModes,
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
    const threadPolicy = codexThreadPolicy(permissionMode, ctx.cwd);
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
              excludeTurns: false,
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
    await lifetime.failOpen();
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
    close: lifetime.close,
    ...createSessionCommands({
      nativeSessionId,
      getLaunchOptions: async (_threadId) => {
        if (ctx.getPermissionMode) permissionMode = await ctx.getPermissionMode();
        const mode = permissionMode;
        return {
          mode,
          options: {
            ...codexTurnPolicy(mode, ctx.cwd),
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
        emit(dir, data, channel);
      },
      getModel: () => model,
      userMessageId: io.userMessageId,
      onInputMessage: ctx.onInputMessage,
      refreshQueue,
    }),
  };
}
