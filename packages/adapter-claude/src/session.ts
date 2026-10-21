import { ClaudePermissionMode } from "@ace/provider-kit/permission-modes";
import { claudeInjection, redactMcpCredential } from "@ace/mcp-server";
import { ClaudeSelectionOptions, claudeSelectionFlags } from "./selection.ts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { elidedJson } from "@ace/provider-kit/binary-elision";
import { randomUUID } from "node:crypto";
import type { Frame, ProviderSession, SessionContext } from "@ace/engine-api";
import { findExecutable } from "@ace/provider-kit/discovery";
import { probeOutput, type SupervisedProcess } from "@ace/provider-kit/process";
import type { InteractionResolution } from "@ace/protocol";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { requireReadableMinimum } from "@ace/provider-kit/cli-requirements";
import { SessionTasks } from "./session-tasks.ts";
import { InputStream, admissions } from "./input.ts";
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
import { readClaudeUsage } from "./usage-read.ts";
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
  const selectedOptions = ClaudeSelectionOptions.parse(ctx.options ?? {});
  const configuration = configurationOptions(options.configuration ?? codingConfiguration);
  if (ctx.fork && ctx.resume) throw new Error("Fork and resume are exclusive");
  if (ctx.fork?.point.type === "turn") throw new Error("Claude requires a native message boundary");
  ctx.signal.throwIfAborted();
  const env = { ...process.env, ...options.env, ...ctx.env };
  const executable = await findExecutable(ctx.executable ?? options.executable ?? "claude", env);
  if (!executable) throw new Error("Claude CLI is not installed");
  const versionProbe = await probeOutput(executable, ["--version"], { env });
  if (versionProbe.code !== 0) throw new Error("Claude version probe failed");
  // Steer binding (user_message_uuids) and the tree contract need the minimum; never run older.
  requireReadableMinimum("claude", versionProbe.stdout);
  ctx.signal.throwIfAborted();
  const sessionId = ctx.resume?.nativeSessionId ?? randomUUID();
  const input = new InputStream();

  const taskIndex = new SessionTasks();
  const tasks = taskIndex.live;
  let sequence = 0;
  const started = performance.now();
  let closed = false;
  let exited = false;
  let sessionConfirmed = Boolean(ctx.resume);
  let failureMessage: string | undefined;
  let ownedProcess: SupervisedProcess | undefined;
  let closePromise: Promise<void> | undefined;
  let q: Query;
  const processId = randomUUID();
  // Attachment bytes stay out of recorded frames; the provider still receives them whole.
  const encode = (data: unknown) =>
    new ProviderPayload(redactMcpCredential(elidedJson(data), ctx.aceMcp));
  const record = (dir: Frame["dir"], channel: string, payload: ProviderPayload) => {
    ctx.onFrame({
      seq: sequence++,
      t: Math.round(performance.now() - started),
      dir,
      channel,
      data: payload.data,
      payload,
    });
  };
  const frame = (dir: Frame["dir"], channel: string, data: unknown) =>
    record(dir, channel, encode(data));
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
  const injection = ctx.aceMcp ? claudeInjection(ctx.aceMcp) : undefined;
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  ctx.signal.throwIfAborted();
  q = query({
    prompt: input,
    options: {
      ...configuration,
      ...(injection
        ? {
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append: injection.developerInstructions,
            },
          }
        : {}),
      ...(ctx.builtinSkills
        ? {
            plugins: ctx.builtinSkills.directories.map((path) => ({
              type: "local" as const,
              path,
            })),
          }
        : {}),
      cwd: ctx.cwd,
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.fork
        ? {
            resume: ctx.fork.nativeSessionId,
            forkSession: true,
            ...(ctx.fork.point.type === "item" ? { resumeSessionAt: ctx.fork.point.nativeId } : {}),
            sessionId,
          }
        : ctx.resume
          ? { resume: sessionId }
          : { sessionId }),
      ...(selectedOptions.effort ? { effort: selectedOptions.effort } : {}),
      pathToClaudeCodeExecutable: executable,
      ...(ctx.permissionMode
        ? {
            permissionMode: ClaudePermissionMode.parse(ctx.permissionMode),
            allowDangerouslySkipPermissions: ctx.permissionMode === "bypassPermissions",
          }
        : {}),
      mcpServers: nativeMcpServers({ ...options.mcpServers, ...injection?.mcpServers }),
      includePartialMessages: true,
      forwardSubagentText: true,
      perTaskStopAffordance: true,
      includeHookEvents: true,
      hooks: {
        // Turn-start digest: what changed in ace since this session's last ace call (P1).
        ...(ctx.aceMcp?.changes
          ? {
              UserPromptSubmit: [
                {
                  hooks: [
                    async () => {
                      const changes = ctx.aceMcp?.changes?.();
                      return changes
                        ? {
                            hookSpecificOutput: {
                              hookEventName: "UserPromptSubmit" as const,
                              additionalContext: changes,
                            },
                          }
                        : {};
                    },
                  ],
                },
              ],
            }
          : {}),
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
      env: { ...env, ...injection?.env, CLAUDE_AGENT_SDK_CLIENT_APP: "ace/0.0.0" },
      spawnClaudeCodeProcess: (spawn) =>
        spawnSdkProcess(spawn, {
          ...(ctx.builtinSkills?.lease ? { lease: ctx.builtinSkills.lease } : {}),
          ...(ctx.outputFlow ? { outputFlow: ctx.outputFlow } : {}),
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
        if (ctx.outputFlow?.paused()) await ctx.outputFlow.wait();
        try {
          const data = object(message);
          if (
            (data["type"] === "system" && data["subtype"] === "init") ||
            (data["type"] === "user" && !data["parent_tool_use_id"])
          ) {
            if (!sessionConfirmed && string(data["session_id"]) === sessionId) {
              sessionConfirmed = true;
              ctx.onSessionConfirmed?.(sessionId);
            }
          }
          frame("recv", "sdk", message);
          taskIndex.observe(data);
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
        } catch (error) {
          // for-await calls the SDK iterator's return before the outer catch.
          // Save the cause before that cleanup can report native process exit.
          failureMessage = String(error);
          throw error;
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
    const commands = await q.supportedCommands();
    frame("note", "commands.runtime", {
      type: "system",
      subtype: "init",
      slash_commands: commands.map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
      })),
    });
    if (ctx.options !== undefined) await q.applyFlagSettings(claudeSelectionFlags(selectedOptions));
    ctx.signal.throwIfAborted();
  } catch (error) {
    await close();
    throw error;
  }
  await q
    .supportedAgents()
    .then((agents) => {
      if (!closed)
        frame("note", "catalog.runtime", {
          method: "agent.list",
          result: { data: agents.map((a) => ({ name: a.name, description: a.description })) },
          cwd: ctx.cwd,
        });
    })
    .catch(() => {});
  // This account's plan limits as they stand now, not only as the last turn left them.
  readClaudeUsage({
    query: q,
    emit: (data) => frame("note", "accounts", data),
    isClosed: () => closed || exited,
  });
  const ensureOpen = () => {
    if (closed || exited) throw new Error("Claude session is closed");
  };
  return {
    nativeSessionId: sessionId,
    get sessionConfirmed() {
      return sessionConfirmed;
    },
    mcp: mcpControls(q, ensureOpen),
    async configure(selection) {
      const executionOptions = ClaudeSelectionOptions.parse(selection.options);
      ensureOpen();
      await q.setModel(selection.model);
      if (ctx.permissionMode)
        await q.setPermissionMode(ClaudePermissionMode.parse(ctx.permissionMode));
      await q.applyFlagSettings(claudeSelectionFlags(executionOptions));
    },
    async send(parts, delivery, commandId, origin) {
      ensureOpen();
      // Validate every admission before the first one can reach the harness.
      const messages = admissions(parts).map((body) => {
        const message: SDKUserMessage & { uuid: string } = {
          type: "user",
          uuid: randomUUID(),
          session_id: sessionId,
          parent_tool_use_id: null,
          message: { role: "user", content: body },
          // A `now` message joins the running turn, but the CLI holds it until the running
          // foreground tool returns. The engine calls backgroundTools for a person's steer.
          priority: delivery === "steer" ? "now" : "next",
        };
        if (origin === "ace") message.isSynthetic = true;
        return message;
      });
      // Encode every frame first: once a message reaches the harness, recording it cannot fail.
      const frames = messages.map((message) => ({ message, payload: encode(message) }));
      for (const { message, payload } of frames) {
        if (commandId) ctx.onInputMessage?.({ commandId, nativeId: message.uuid });
        input.push(message);
        record("send", "sdk", payload);
      }
    },
    // The terminal's Ctrl+B: each blocking Bash or subagent call returns at once and keeps
    // running as a background task, so the queued `now` message is taken right away. Throws
    // when background tasks are disabled (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).
    async backgroundTools() {
      ensureOpen();
      return q.backgroundTasks();
    },
    async interrupt(target) {
      ensureOpen();
      const failures: unknown[] = [];
      let targetId: string | undefined;
      let targetSpawn = "";
      if (target.agent && target.agent !== (ctx.rootKey ?? "root") && target.agent !== sessionId) {
        const spawn = nativeKey(target.agent, "child");
        const task = taskIndex.resolve(spawn) ?? taskIndex.resolve(spawn.replace(/^native:/, ""));
        if (!task) throw new Error("Claude child is no longer available for individual stop");
        targetId = task.id;
        targetSpawn = task.spawn;
        if (task.live)
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
    },
    async stopTask(key) {
      ensureOpen();
      await q.stopTask(nativeKey(key, "task"));
    },
    close,
  };
}
