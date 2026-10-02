import { randomUUID } from "node:crypto";
import type { Frame, ProviderSession, SessionContext } from "@ace/engine-api";
import { findExecutable } from "@ace/provider-kit/discovery";
import { probeOutput, type SupervisedProcess } from "@ace/provider-kit/process";
import type { InteractionResolution } from "@ace/protocol";
import {
  query,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { capabilities } from "./capabilities.ts";
import { InputStream, content, permissionResult } from "./input.ts";
import { object, string } from "./native.ts";
import { requestFor } from "./interactions.ts";
import { spawnSdkProcess } from "./sdk-process.ts";
export interface ClaudeOptions {
  executable?: string;
  env?: NodeJS.ProcessEnv;
}
interface Pending {
  kind: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  finish(result: PermissionResult, cancelled?: boolean): void;
}
export async function openSession(
  ctx: SessionContext,
  options: ClaudeOptions = {},
): Promise<ProviderSession> {
  ctx.signal.throwIfAborted();
  const env = { ...process.env, ...options.env };
  const executable = await findExecutable(options.executable ?? "claude", env);
  if (!executable) throw new Error("Claude CLI is not installed");
  const versionProbe = await probeOutput(executable, ["--version"], { env });
  if (versionProbe.code !== 0) throw new Error("Claude version probe failed");
  const version = versionProbe.stdout.split(/\s/)[0];
  if (
    !capabilities({
      installed: true,
      auth: "unknown",
      loginHint: "claude, then /login",
      ...(version ? { version } : {}),
    }).backgroundTaskControl
  )
    throw new Error("Claude CLI 2.1.286 or newer is required");
  ctx.signal.throwIfAborted();
  const sessionId = ctx.resume?.nativeSessionId ?? randomUUID();
  const input = new InputStream();
  const pending = new Map<string, Pending>();
  const toolParents = new Map<string, string>();
  const tasks = new Map<string, { spawn: string; parent: string; live: boolean }>();
  let sequence = 0;
  const started = performance.now();
  let closed = false;
  let exited = false;
  let ownedProcess: SupervisedProcess | undefined;
  let closePromise: Promise<void> | undefined;
  let q: Query;
  const processId = randomUUID();
  const frame = (dir: Frame["dir"], channel: string, data: unknown) =>
    ctx.onFrame({
      seq: sequence++,
      t: Math.round(performance.now() - started),
      dir,
      channel,
      data,
    });
  const end = (deliberate: boolean, message?: string) => {
    if (exited) return;
    exited = true;
    for (const request of pending.values())
      request.finish({ behavior: "deny", message: "Claude session ended." }, true);
    input.close();
    ctx.signal.removeEventListener("abort", abort);
    // Engine owns process.exited facts through onExit. Avoid sending a duplicate lifecycle frame.
    ctx.onExit({ deliberate, ...(message ? { message } : {}) });
  };
  const abort = () => {
    void close();
  };
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closed = true;
      for (const request of pending.values())
        request.finish({ behavior: "deny", message: "Claude session closed." }, true);
      input.close();
      q.close();
      if (ownedProcess) await ownedProcess.stop();
      await pump;
      end(true);
    })();
    return closePromise;
  };
  frame("note", "lifecycle", {
    type: "process.started",
    session_id: sessionId,
    process_id: processId,
    cwd: ctx.cwd,
  });
  q = query({
    prompt: input,
    options: {
      cwd: ctx.cwd,
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.resume ? { resume: sessionId } : { sessionId }),
      pathToClaudeCodeExecutable: executable,
      permissionMode: "default",
      settingSources: [],
      includePartialMessages: true,
      forwardSubagentText: true,
      perTaskStopAffordance: true,
      includeHookEvents: true,
      env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: "ace/0.0.0" },
      spawnClaudeCodeProcess: (spawn) =>
        spawnSdkProcess(spawn, {
          onStderr: (line) => frame("stderr", "sdk", line),
          onWire: (dir, data) =>
            frame(dir, object(data)["type"] === "control_cancel_request" ? "sdk" : "wire", data),
          onProcess: (handle) => {
            ownedProcess = handle;
            void handle.exited.then((exit) =>
              end(closed, `Claude process exited: ${exit.code ?? exit.signal ?? exit.reason}`),
            );
          },
        }),
      canUseTool: (toolName, toolInput, toolOptions) =>
        new Promise<PermissionResult>((resolve) => {
          const { signal, ...meta } = toolOptions;
          const id = toolOptions.requestId;
          const cancelled = () =>
            pending
              .get(id)
              ?.finish({ behavior: "deny", message: "Claude cancelled the request." }, true);
          pending.set(id, {
            kind: requestFor(toolName, toolInput, meta).kind,
            input: toolInput,
            suggestions: toolOptions.suggestions ?? [],
            finish(result, cancel = false) {
              if (!pending.delete(id)) return;
              signal.removeEventListener("abort", cancelled);
              frame(
                cancel ? "recv" : "send",
                cancel ? "sdk" : "can_use_tool",
                cancel
                  ? { type: "control_cancel_request", request_id: id }
                  : { requestId: id, result },
              );
              resolve(result);
            },
          });
          frame("recv", "can_use_tool", { toolName, input: toolInput, options: meta });
          if (signal.aborted || closed || exited) cancelled();
          else signal.addEventListener("abort", cancelled, { once: true });
        }),
    },
  });
  const pump = (async () => {
    try {
      for await (const message of q) {
        const data = object(message);
        if (data["type"] === "assistant")
          for (const value of Array.isArray(object(data["message"])["content"])
            ? (object(data["message"])["content"] as unknown[])
            : []) {
            const block = object(value);
            if (block["type"] === "tool_use")
              toolParents.set(string(block["id"]), string(data["parent_tool_use_id"]));
          }
        if (data["type"] === "system" && data["subtype"] === "task_started") {
          const id = string(data["task_id"]);
          const spawn = string(data["tool_use_id"]);
          tasks.set(id, { spawn, parent: toolParents.get(spawn) ?? "", live: true });
        }
        if (
          data["type"] === "system" &&
          (data["subtype"] === "task_updated" || data["subtype"] === "task_notification")
        ) {
          const task = tasks.get(string(data["task_id"]));
          if (
            task &&
            ["completed", "failed", "killed", "stopped"].includes(
              string(data["status"], string(object(data["patch"])["status"])),
            )
          )
            task.live = false;
        }
        frame("recv", "sdk", message);
      }
      end(closed);
    } catch (error) {
      if (ownedProcess) await ownedProcess.stop();
      end(closed, String(error));
    }
  })();
  ctx.signal.addEventListener("abort", abort, { once: true });
  try {
    await q.supportedCommands();
    ctx.signal.throwIfAborted();
  } catch (error) {
    await close();
    throw error;
  }
  const ensureOpen = () => {
    if (closed || exited) throw new Error("Claude session is closed");
  };
  function nativeKey(key: string, kind: string): string {
    return key.includes(`:${kind}:`)
      ? key.slice(key.lastIndexOf(`:${kind}:`) + kind.length + 2)
      : key;
  }
  return {
    nativeSessionId: sessionId,
    async send(parts, delivery) {
      ensureOpen();
      if (delivery === "steer")
        throw new Error("Claude steering is unverified; queue the input instead");
      const message = {
        type: "user" as const,
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: "user" as const, content: content(parts) },
        priority: "next" as const,
      };
      frame("send", "sdk", message);
      input.push(message);
    },
    async interrupt(target) {
      ensureOpen();
      let targetId: string | undefined;
      if (target.agent && target.agent !== "root" && target.agent !== sessionId) {
        const spawn = nativeKey(target.agent, "child");
        targetId = [...tasks].find(
          ([id, task]) => id === target.agent || task.spawn === spawn,
        )?.[0];
        if (!targetId) throw new Error("Unknown Claude child agent");
        await q.stopTask(targetId);
      } else await q.interrupt();
      if (target.cascade) {
        const spawns = new Set<string>();
        if (targetId) spawns.add(tasks.get(targetId)!.spawn);
        let changed = true;
        while (changed) {
          changed = false;
          for (const task of tasks.values())
            if (spawns.has(task.parent) && !spawns.has(task.spawn)) {
              spawns.add(task.spawn);
              changed = true;
            }
        }
        for (const [id, task] of tasks)
          if (task.live && id !== targetId && (!targetId || spawns.has(task.parent)))
            await q.stopTask(id);
      }
    },
    async resolve(key, resolution: InteractionResolution) {
      ensureOpen();
      const id = nativeKey(key, "interaction");
      const request = pending.get(id);
      if (!request) throw new Error("Claude interaction is no longer pending");
      if (request.kind !== resolution.kind)
        throw new Error("Claude interaction resolution kind does not match");
      const result = permissionResult(resolution, request.input, request.suggestions);
      request.finish(result);
      if (resolution.kind === "plan_review" && resolution.decision === "approve")
        await q.setPermissionMode("default");
    },
    async stopTask(key) {
      ensureOpen();
      await q.stopTask(nativeKey(key, "task"));
    },
    close,
  };
}
