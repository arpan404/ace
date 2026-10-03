import { randomUUID } from "node:crypto";
import type { Frame, ProviderSession, SessionContext } from "@ace/engine-api";
import { findExecutable } from "@ace/provider-kit/discovery";
import { probeOutput, type SupervisedProcess } from "@ace/provider-kit/process";
import type { InteractionResolution } from "@ace/protocol";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { capabilities } from "./capabilities.ts";
import { SessionTasks } from "./session-tasks.ts";
import { InputStream, content } from "./input.ts";
import { object, string } from "./native.ts";
import { PendingInteractions } from "./pending-interactions.ts";
import {
  codingConfiguration,
  configurationOptions,
  type ClaudeConfiguration,
} from "./configuration.ts";
import { ClaudeRateLimitObservation } from "./rate-limits.ts";
import { nativeMcpServers, mcpControls, type ClaudeMcpServers } from "./mcp-controls.ts";
import { spawnSdkProcess } from "./sdk-process.ts";
export interface ClaudeOptions {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  configuration?: ClaudeConfiguration;
  mcpServers?: ClaudeMcpServers;
  /** Accounts owner receives stable event metadata. This adapter never polls usage or changes auth. */
  onRateLimit?(observation: ClaudeRateLimitObservation): void;
}
function nativeKey(key: string, kind: string): string {
  return key.includes(`:${kind}:`)
    ? key.slice(key.lastIndexOf(`:${kind}:`) + kind.length + 2)
    : key;
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

  const taskIndex = new SessionTasks();
  const tasks = taskIndex.live;
  let sequence = 0;
  const started = performance.now();
  let closed = false;
  let exited = false;
  let failureMessage: string | undefined;
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
  const pending = new PendingInteractions(frame);
  const end = (deliberate: boolean, message?: string) => {
    if (exited) return;
    exited = true;
    pending.expire();
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
      pending.expire();
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
      ...configurationOptions(options.configuration ?? codingConfiguration),
      mcpServers: nativeMcpServers(options.mcpServers ?? {}),
      includePartialMessages: true,
      forwardSubagentText: true,
      perTaskStopAffordance: true,
      includeHookEvents: true,
      hooks: {
        SubagentStart: [
          {
            hooks: [
              async (data) => {
                frame("recv", "observational_hook", data);
                return {};
              },
            ],
          },
        ],
        SubagentStop: [
          {
            hooks: [
              async (data) => {
                frame("recv", "observational_hook", data);
                return {};
              },
            ],
          },
        ],
      },
      env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: "ace/0.0.0" },
      spawnClaudeCodeProcess: (spawn) =>
        spawnSdkProcess(spawn, {
          onStderr: (line) => frame("stderr", "sdk", line),
          onWire: (dir, data) => {
            const cancel = object(data)["type"] === "control_cancel_request";
            if (dir === "recv" && cancel) {
              const id = string(object(data)["request_id"]);
              pending.cancel(id);
            }
            frame(dir, cancel ? "sdk" : "wire", data);
          },
          onProcess: (handle) => {
            ownedProcess = handle;
            if (handle.signal.aborted) pending.expire();
            else handle.signal.addEventListener("abort", () => pending.expire(), { once: true });
            void handle.exited.then((exit) =>
              end(
                closed,
                failureMessage ??
                  `Claude process exited: ${exit.code ?? exit.signal ?? exit.reason}`,
              ),
            );
          },
        }),
      canUseTool: (toolName, toolInput, toolOptions) =>
        pending.permission(toolName, toolInput, toolOptions),
      onElicitation: (request, meta) => pending.elicitation(request, meta),
      // No product renderer currently answers a native user-dialog kind.
      onUserDialog: async (request) => {
        frame("recv", "user_dialog", request);
        return { behavior: "cancelled" };
      },
    },
  });
  const pump = (async () => {
    try {
      for await (const message of q) {
        const data = object(message);
        taskIndex.observe(data);
        frame("recv", "sdk", message);
        if (data["type"] === "rate_limit_event") {
          const observation = ClaudeRateLimitObservation.safeParse(data["rate_limit_info"]);
          if (observation.success) {
            try {
              options.onRateLimit?.(observation.data);
            } catch {
              frame("note", "accounts", { type: "rate_limit_observation_failed" });
            }
          }
        }
      }
      end(closed);
    } catch (error) {
      failureMessage = String(error);
      if (ownedProcess) await ownedProcess.stop();
      end(closed, failureMessage);
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
  return {
    nativeSessionId: sessionId,
    mcp: mcpControls(q, ensureOpen),
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
      input.push(message);
      frame("send", "sdk", message);
    },
    async interrupt(target) {
      ensureOpen();
      const failures: unknown[] = [];
      let targetId: string | undefined;
      let targetSpawn = "";
      if (target.agent && target.agent !== (ctx.rootKey ?? "root") && target.agent !== sessionId) {
        const spawn = nativeKey(target.agent, "child");
        targetId = [...tasks].find(
          ([id, task]) =>
            id === target.agent || id === spawn.replace(/^native:/, "") || task.spawn === spawn,
        )?.[0];
        if (!targetId) throw new Error("Unknown Claude child agent");
        targetSpawn = tasks.get(targetId)?.spawn ?? "";
        try {
          await q.stopTask(targetId);
        } catch (error) {
          failures.push(error);
        }
      } else {
        try {
          const receipt = await q.interrupt();
          if (receipt) frame("note", "interrupt_receipt", receipt);
        } catch (error) {
          failures.push(error);
        }
      }
      if (target.cascade) {
        const cascade = targetId
          ? taskIndex.cascade(targetSpawn)
          : { ids: [...tasks].filter(([, task]) => task.live).map(([id]) => id), uncertain: false };
        if (cascade.uncertain)
          failures.push(new Error("Claude cascade ancestry is no longer fully correlated"));
        for (const id of cascade.ids)
          if (id !== targetId)
            try {
              await q.stopTask(id);
            } catch (error) {
              failures.push(error);
            }
      }
      if (failures.length)
        throw new AggregateError(failures, "Claude interrupt could not stop every requested task");
    },
    async resolve(key, resolution: InteractionResolution) {
      ensureOpen();
      const id = nativeKey(key, "interaction");
      pending.resolve(id, resolution);
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
