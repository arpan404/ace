// SPDX-License-Identifier: Apache-2.0
/**
 * The native Claude facade behind `ACE_SESSIONS=claude` (E3-claude.4). It is `openSession` with
 * the per-line half replaced: the Rust session frames, redacts, classifies, tracks tasks and
 * interactions, writes stdin and settles control requests through the shared bridge (E3.0c).
 * This file keeps the open-time and control composition (discovery, the version gate, MCP
 * injection and listing, the launch argv, configure, interrupt, resolve, close) and owns the
 * child's process.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { ClaudePermissionMode } from "@ace/provider-kit/permission-modes";
import { claudeInjection, claudeToolListing, privateMcpConfig } from "@ace/mcp-server";
import {
  assertSteerTarget,
  InputRejected,
  type ProviderMcpControl,
  type ProviderSession,
  type SessionContext,
} from "@ace/engine-api";
import {
  InteractionRequest,
  InteractionResolution as InteractionResolutionSchema,
  type InteractionResolution,
} from "@ace/protocol";
import { findExecutable } from "@ace/provider-kit/discovery";
import {
  probeOutput,
  spawnSupervised,
  type SpawnOptions,
  type SupervisedProcess,
} from "@ace/provider-kit/process";
import { requireReadableMinimum } from "@ace/provider-kit/cli-requirements";
import { sessionsAddonPath } from "@ace/provider-kit/native-switches";
import {
  sessionBridge,
  type BridgeHooks,
  type NativeSessionPort,
  type SessionBridge,
} from "@ace/provider-kit/native-session-bridge";
import { ClaudeSelectionOptions, claudeSelectionFlags } from "./selection.ts";
import {
  codingConfiguration,
  configurationOptions,
  type ClaudeConfiguration,
} from "./configuration.ts";
import { admissions, permissionResult } from "./input.ts";
import { ElicitationAnswer } from "./pending-interactions.ts";
import { ClaudeRateLimitObservation } from "./rate-limits.ts";
import { nativeMcpServers, type ClaudeMcpServers } from "./mcp-controls.ts";
import { AceListing } from "./ace-listing.ts";
import { claudeToolSearchFacts } from "./tool-search-facts.ts";
import { readClaudeUsage } from "./usage-read.ts";
import { CliVersions } from "./cli-versions.ts";
import { list, object, string } from "./native.ts";
import type { ClaudeOptions } from "./session.ts";

export interface NativeClaudeHandle extends NativeSessionPort {
  outputTarget(): NonNullable<SpawnOptions["nativeOutput"]>;
  launchArgs(launchJson: string): string[];
  control(requestJson: string, id: number): void;
  send(messagesJson: string, commandId: string | null): void;
  peekInteraction(id: string): string | null | undefined;
  answerInteraction(id: string, resultJson: string, resolutionJson: string): boolean;
  answerHook(requestId: string, outputJson: string): void;
  taskTarget(spawn: string): string | null | undefined;
  taskCascade(spawn: string | null): string;
  note(json: string): void;
  timer(key: string): void;
  endInput(): void;
  expire(): void;
  undrain(): void;
  abandon(): void;
}

export interface NativeSessionsAddon {
  ClaudeSessionNative: new (
    configJson: string,
    events: (error: unknown, batch: string) => void,
  ) => NativeClaudeHandle;
}

let loaded: NativeSessionsAddon | undefined;

/** The sessions addon, loaded once; absent, the open fails rather than running TypeScript. */
function addon(): NativeSessionsAddon {
  if (loaded) return loaded;
  const path = sessionsAddonPath();
  if (!existsSync(path)) throw new Error(`ACE_SESSIONS=claude needs the sessions addon at ${path}`);
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  loaded = module.exports as unknown as NativeSessionsAddon;
  return loaded;
}

function nativeKey(key: string, kind: string): string {
  return key.includes(`:${kind}:`)
    ? key.slice(key.lastIndexOf(`:${kind}:`) + kind.length + 2)
    : key;
}

function unrefSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/** A synchronous binding throw: `ACE_INPUT_REJECTED` is the engine's refusal, the rest a plain error. */
function refusal(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return code === "ACE_INPUT_REJECTED"
    ? new InputRejected(message, { cause: error })
    : new Error(message);
}

/** `mcpControls`' five calls, each one control request; the response shapes stay validated here. */
const statusResult = z
  .array(z.object({ name: z.string(), status: z.string() }).passthrough())
  .max(256);
const setResult = z
  .object({
    added: z.array(z.string()).max(256),
    removed: z.array(z.string()).max(256),
    errors: z.record(z.string(), z.string()),
  })
  .passthrough();

const text = z.string().min(1).max(8192);

export async function openNativeClaudeSession(
  ctx: SessionContext,
  options: ClaudeOptions = {},
  versions: CliVersions = new CliVersions(),
  load: () => NativeSessionsAddon = addon,
): Promise<ProviderSession> {
  ctx.signal.throwIfAborted();
  const native = load();
  const selectedOptions = ClaudeSelectionOptions.parse(ctx.options ?? {});
  const configuration: ReturnType<typeof configurationOptions> = configurationOptions(
    options.configuration ?? codingConfiguration,
  );
  if (ctx.fork && ctx.resume) throw new Error("Fork and resume are exclusive");
  if (ctx.fork?.point.type === "turn") throw new Error("Claude requires a native message boundary");
  const env = { ...process.env, ...options.env, ...ctx.env, ...ctx.agentEnv };
  const executable = await findExecutable(ctx.executable ?? options.executable ?? "claude", env);
  if (!executable) throw new Error("Claude CLI is not installed");
  const version = await versions.read(executable, async () => {
    const probe = await probeOutput(executable, ["--version"], { env });
    if (probe.code !== 0) throw new Error("Claude version probe failed");
    return probe.stdout;
  });
  requireReadableMinimum("claude", version);
  ctx.signal.throwIfAborted();

  const sessionId = ctx.resume?.nativeSessionId ?? randomUUID();
  const processId = randomUUID();
  const toolSearchFacts = (model: string | undefined) =>
    claudeToolSearchFacts({
      env,
      cwd: ctx.cwd,
      sources: configuration.settingSources ?? [],
      model,
    });
  const listing = ctx.aceMcp ? claudeToolListing(await toolSearchFacts(ctx.model)) : undefined;
  const injection = ctx.aceMcp ? claudeInjection({ ...ctx.aceMcp, listing }) : undefined;
  const servers = { ...options.mcpServers, ...injection?.mcpServers };
  const aceListing =
    ctx.aceMcp && listing ? new AceListing(ctx.aceMcp, listing, servers) : undefined;

  // The hook ids are ace's own; the wire learns them from the initialize it writes.
  let nextHook = 0;
  const hookId = () => `hook_${nextHook++}`;
  const hooks: Record<string, { hookCallbackIds: string[] }[]> = {};
  if (ctx.aceMcp?.changes) hooks.UserPromptSubmit = [{ hookCallbackIds: [hookId()] }];
  hooks.SubagentStart = [{ hookCallbackIds: [hookId()] }];
  hooks.SubagentStop = [{ hookCallbackIds: [hookId()] }];

  let bridge: SessionBridge;
  let handle: NativeClaudeHandle;
  try {
    handle = new native.ClaudeSessionNative(
      JSON.stringify({
        sessionId,
        rootKey: ctx.rootKey ?? "root",
        ...(ctx.aceMcp ? { bearer: ctx.aceMcp.bearer } : {}),
        resume: Boolean(ctx.resume),
      }),
      (_error: unknown, batch: string) => bridge.deliver(batch),
    );
  } catch (error) {
    throw error;
  }

  const nativeServers = nativeMcpServers(servers);
  const launch = {
    session: ctx.fork
      ? {
          kind: "fork",
          source: ctx.fork.nativeSessionId,
          ...(ctx.fork.point.type === "item" ? { at: ctx.fork.point.nativeId } : {}),
          sessionId,
        }
      : ctx.resume
        ? { kind: "resume", sessionId }
        : { kind: "new", sessionId },
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(selectedOptions.effort ? { effort: selectedOptions.effort } : {}),
    ...(configuration.permissionMode ? { permissionMode: configuration.permissionMode } : {}),
    allowDangerouslySkipPermissions: ctx.permissionMode === "bypassPermissions",
    ...(configuration.settingSources ? { settingSources: configuration.settingSources } : {}),
    strictMcpConfig: configuration.strictMcpConfig ?? false,
    ...(Object.keys(nativeServers).length
      ? { mcpConfig: JSON.stringify({ mcpServers: nativeServers }) }
      : {}),
    pluginDirs: ctx.builtinSkills?.directories ?? [],
    includePartialMessages: true,
    includeHookEvents: true,
    extra: ctx.chrome !== undefined ? [[ctx.chrome ? "chrome" : "no-chrome", null]] : [],
  };
  const args = handle.launchArgs(JSON.stringify(launch));
  // The caller swaps an inline `--mcp-config` for a private file (`sdk-process.ts:31`-`:34`).
  let configurationFile: ReturnType<typeof privateMcpConfig> | undefined;
  const configAt = args.indexOf("--mcp-config");
  if (configAt >= 0 && args[configAt + 1]?.startsWith("{")) {
    configurationFile = privateMcpConfig(args[configAt + 1] ?? "", ctx.cwd);
    args[configAt + 1] = configurationFile.path;
  }

  let sessionConfirmed = Boolean(ctx.resume);
  const callbacks = {
    ...ctx,
    onSessionConfirmed: (id: string) => {
      sessionConfirmed = true;
      ctx.onSessionConfirmed?.(id);
    },
    onRateLimit: (observation: unknown) => {
      const parsed = ClaudeRateLimitObservation.safeParse(observation);
      if (!parsed.success) return;
      try {
        options.onRateLimit?.(parsed.data);
      } catch {
        note("accounts", { type: "rate_limit_observation_failed" });
      }
    },
    "hook:UserPromptSubmit": (requestId: string) => {
      const changes = ctx.aceMcp?.changes?.();
      handle.answerHook(
        requestId,
        JSON.stringify(
          changes
            ? {
                hookSpecificOutput: {
                  hookEventName: "UserPromptSubmit",
                  additionalContext: changes,
                },
              }
            : {},
        ),
      );
    },
  };
  let spawned = false;
  let proc: SupervisedProcess;
  let failureMessage: string | undefined;
  const hooksForBridge: BridgeHooks = {
    now: () => performance.now(),
    started: 0,
    schedule: unrefSchedule,
    timer: (key) => handle.timer(key),
    fatal: (message) => {
      failureMessage = message;
      if (spawned) void close("shutdown", false).catch(stopFailed);
    },
    drained: () => {
      if (spawned) void onDrained();
    },
  };
  bridge = sessionBridge(callbacks, handle, hooksForBridge, {
    ACE_INPUT_REJECTED: InputRejected,
    ACE_CLAUDE_UNCERTAIN: Error,
    ACE_CLAUDE_CONTROL: Error,
  });

  const started = performance.now();
  hooksForBridge.started = started;
  try {
    proc = spawnSupervised({
      command: executable,
      args,
      cwd: ctx.cwd,
      env: {
        ...env,
        ...injection?.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "ace/0.0.0",
        CLAUDE_CODE_SDK_READS_SESSION_STATE: "1",
      },
      name: "claude",
      ...(ctx.builtinSkills?.lease ? { lease: ctx.builtinSkills.lease } : {}),
      ...(ctx.outputFlow ? { outputFlow: ctx.outputFlow } : {}),
      maxLineBytes: 16 * 1024 * 1024,
      onStderrLineDropped: () => {},
      nativeOutput: handle.outputTarget(),
    });
  } catch (error) {
    handle.abandon();
    configurationFile?.remove();
    throw error;
  }
  spawned = true;

  let closed = false;
  let closing = false;
  let deliberate = false;
  let exited = false;
  let closePromise: Promise<void> | undefined;
  let nextId = 0;

  const note = (channel: string, data: unknown) => handle.note(JSON.stringify({ channel, data }));
  const ensureOpen = () => {
    if (closed || exited) throw new Error("Claude session is closed");
    ctx.signal.throwIfAborted();
  };
  const abort = () => void close("shutdown").catch(stopFailed);
  const release = () => {
    configurationFile?.remove();
    ctx.signal.removeEventListener("abort", abort);
  };
  const stopFailed = (error: unknown) =>
    note("lifecycle", {
      event: "stop-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  async function onDrained(): Promise<void> {
    const exit = await proc.exited;
    if (exited) return;
    exited = true;
    const message =
      failureMessage ?? `Claude process exited: ${exit.code ?? exit.signal ?? exit.reason}`;
    ctx.onExit({ deliberate, message });
  }
  function control(request: Record<string, unknown>): Promise<unknown> {
    ensureOpen();
    const id = ++nextId;
    try {
      handle.control(JSON.stringify(request), id);
    } catch (error) {
      return Promise.reject(refusal(error));
    }
    return bridge.expect(id);
  }
  function nativeMcpControls(check: () => void): ProviderMcpControl {
    return {
      async status(): Promise<unknown> {
        check();
        return statusResult.parse(object(await control({ subtype: "mcp_status" }))["mcpServers"]);
      },
      async replace(servers) {
        check();
        const result = setResult.parse(
          await control({ subtype: "mcp_set_servers", servers: nativeMcpServers(servers) }),
        );
        if (Object.keys(result.errors).length)
          throw new Error(
            `Claude MCP connection failures: ${Object.entries(result.errors)
              .map(([name, error]) => `${name}: ${error}`)
              .join("; ")}`,
          );
        return result;
      },
      async reconnect(name) {
        check();
        await control({ subtype: "mcp_reconnect", serverName: text.parse(name) });
      },
      async enable(name) {
        check();
        await control({ subtype: "mcp_toggle", serverName: text.parse(name), enabled: true });
      },
      async disable(name) {
        check();
        await control({ subtype: "mcp_toggle", serverName: text.parse(name), enabled: false });
      },
    };
  }
  function taskFrom(spawn: string): Record<string, unknown> | undefined {
    const json = handle.taskTarget(spawn);
    return json === null || json === undefined ? undefined : object(JSON.parse(json));
  }
  function close(
    _reason: "idle" | "user" | "shutdown" = "shutdown",
    expected = true,
  ): Promise<void> {
    if (closePromise) return closePromise;
    const previous = deliberate;
    closing = true;
    deliberate = expected;
    // Read on to EOF, expire the interactions with their default answers, then end input.
    handle.drain();
    handle.expire();
    handle.endInput();
    closePromise = (async () => {
      try {
        await proc.stop();
      } catch (error) {
        // The session is then stop-only, not usable: no write follows a failed stop.
        closePromise = undefined;
        deliberate = previous;
        handle.undrain();
        throw error;
      }
      await bridge.drainedPromise;
      release();
    })();
    return closePromise;
  }

  note("lifecycle", {
    type: "process.started",
    session_id: sessionId,
    process_id: processId,
    cwd: ctx.cwd,
  });
  ctx.signal.addEventListener("abort", abort, { once: true });
  void proc.exited
    .then(() => {
      closed = true;
    })
    .catch(stopFailed);
  try {
    const initialized = object(
      await control({
        subtype: "initialize",
        hooks,
        ...(injection ? { appendSystemPrompt: injection.developerInstructions } : {}),
        ...(configuration.systemPrompt === undefined ? { systemPrompt: [""] } : {}),
        forwardSubagentText: true,
        perTaskStopAffordance: true,
      }),
    );
    note("commands.runtime", {
      type: "system",
      subtype: "init",
      slash_commands: list(initialized["commands"]).map((value) => {
        const command = object(value);
        return {
          name: string(command["name"]),
          description: string(command["description"]),
          argumentHint: string(command["argumentHint"]),
        };
      }),
    });
    if (ctx.options !== undefined)
      await control({
        subtype: "apply_flag_settings",
        settings: claudeSelectionFlags(selectedOptions),
      });
    ctx.signal.throwIfAborted();
    const agents = list(initialized["agents"]);
    if (!closed)
      note("catalog.runtime", {
        method: "agent.list",
        result: {
          data: agents.map((value) => {
            const agent = object(value);
            return { name: string(agent["name"]), description: string(agent["description"]) };
          }),
        },
        cwd: ctx.cwd,
      });
  } catch (error) {
    await close();
    throw error;
  }
  readClaudeUsage({
    query: {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (read) =>
        control({ subtype: "get_usage", skip_behaviors: read?.skipBehaviors === true }),
    },
    emit: (data) => note("accounts", data),
    isClosed: () => closed || exited,
  });
  const baseControls = nativeMcpControls(ensureOpen);
  const evidence = process.env.ACE_SESSIONS_EVIDENCE;
  if (evidence !== undefined)
    appendFileSync(
      evidence,
      `${JSON.stringify({ provider: "claude", backend: "native", pid: process.pid })}\n`,
    );
  return {
    nativeSessionId: sessionId,
    get sessionConfirmed() {
      return sessionConfirmed;
    },
    mcp: aceListing ? aceListing.controls(baseControls) : baseControls,
    async configure(selection) {
      const executionOptions = ClaudeSelectionOptions.parse(selection.options);
      ensureOpen();
      await control({
        subtype: "set_model",
        ...(selection.model ? { model: selection.model } : {}),
      });
      await aceListing?.update(await toolSearchFacts(selection.model), baseControls);
      if (ctx.permissionMode)
        await control({
          subtype: "set_permission_mode",
          mode: ClaudePermissionMode.parse(ctx.permissionMode),
        });
      await control({
        subtype: "apply_flag_settings",
        settings: claudeSelectionFlags(executionOptions),
      });
    },
    async send(parts, delivery, commandId, origin, fence) {
      ensureOpen();
      if (aceListing?.unsettled) await aceListing.settle(baseControls).catch(() => {});
      const messages = admissions(parts).map((body) => ({
        type: "user",
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: "user", content: body },
        priority: delivery === "steer" && origin === undefined ? "now" : "next",
        ...(origin === "ace" ? { isSynthetic: true } : {}),
      }));
      // Rule 1: the fence check and the one synchronous binding call, with nothing between.
      assertSteerTarget(delivery, fence);
      try {
        handle.send(JSON.stringify(messages), commandId ?? null);
      } catch (error) {
        throw refusal(error);
      }
    },
    async backgroundTools() {
      ensureOpen();
      return object(await control({ subtype: "background_tasks" }))["backgrounded"] === true;
    },
    async interrupt(target) {
      ensureOpen();
      const failures: unknown[] = [];
      let targetId: string | undefined;
      let targetSpawn = "";
      if (target.agent && target.agent !== (ctx.rootKey ?? "root") && target.agent !== sessionId) {
        const spawn = nativeKey(target.agent, "child");
        const task = taskFrom(spawn) ?? taskFrom(spawn.replace(/^native:/, ""));
        if (!task) throw new Error("Claude child is no longer available for individual stop");
        targetId = string(task["id"]);
        targetSpawn = string(task["spawn"]);
        if (task["live"] === true)
          try {
            await control({ subtype: "stop_task", task_id: targetId });
          } catch (error) {
            failures.push(error);
          }
      } else {
        try {
          const receipt = await control({ subtype: "interrupt" });
          if (receipt) note("interrupt_receipt", receipt);
        } catch (error) {
          failures.push(error);
        }
      }
      if (target.cascade) {
        const cascade = object(JSON.parse(handle.taskCascade(targetId ? targetSpawn : null)));
        if (cascade["uncertain"] === true)
          failures.push(new Error("Claude cascade ancestry is no longer fully correlated"));
        for (const id of list(cascade["ids"]))
          if (id !== targetId)
            try {
              await control({ subtype: "stop_task", task_id: string(id) });
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
      const peek = handle.peekInteraction(id);
      if (peek === null || peek === undefined)
        throw new Error("Claude interaction is no longer pending");
      const request = InteractionRequest.parse(JSON.parse(peek));
      const parsed = InteractionResolutionSchema.parse(resolution);
      if (parsed.kind !== request.kind)
        throw new Error("Claude interaction resolution kind does not match");
      if (
        parsed.kind === "approval" &&
        request.kind === "approval" &&
        !request.options.some((option) => option.id === parsed.optionId)
      )
        throw new Error("Unknown Claude approval option");
      const result =
        parsed.kind === "elicitation"
          ? ElicitationAnswer.parse({
              action: parsed.action,
              ...(parsed.content === undefined ? {} : { content: parsed.content }),
            })
          : permissionResult(
              parsed,
              object(request.kind === "approval" ? request.target?.input : undefined),
              (request.kind === "approval" ? (request.permissionUpdates ?? []) : []) as Parameters<
                typeof permissionResult
              >[2],
            );
      if (!handle.answerInteraction(id, JSON.stringify(result), JSON.stringify(parsed)))
        throw new Error("Claude interaction is no longer pending");
    },
    async stopTask(key) {
      ensureOpen();
      await control({ subtype: "stop_task", task_id: nativeKey(key, "task") });
    },
    close,
  };
}
