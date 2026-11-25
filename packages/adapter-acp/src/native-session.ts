// SPDX-License-Identifier: Apache-2.0
/**
 * The native ACP facade behind `ACE_SESSIONS=acp` (E3-acp.3). It is `openAcpSession` with the
 * per-line half replaced: the Rust session frames, redacts, settles requests, answers the
 * agent's requests, steers, queues and closes, through the shared bridge (E3.0c). This file
 * keeps the open's composition (the addon, the lease, the spawn, the sign-in retry), the
 * engine-facing surface, and the stop plan.
 */

import { existsSync } from "node:fs";
import { SessionOpenError } from "@ace/provider-kit/open-error";
import { openWithSignIn } from "@ace/provider-kit/acp-sign-in";
import { sessionsAddonPath } from "@ace/provider-kit/native-switches";
import {
  sessionBridge,
  type BridgeHooks,
  type NativeSessionPort,
  type SessionBridge,
} from "@ace/provider-kit/native-session-bridge";
import type { SpawnOptions } from "@ace/provider-kit/process";
import { recordTree, type RecordedTree } from "@ace/provider-kit/tree-stop";
import {
  assertSteerTarget,
  InputRejected,
  SteerTargetLost,
  type InputSource,
  type ProviderSession,
  type SessionContext,
  type SteerFence,
} from "@ace/engine-api";
import type { ContentPart, InteractionResolution } from "@ace/protocol";
import { developerInstructions } from "@ace/mcp-server";
import { appendFileSync } from "node:fs";
import type { LaunchOptions, SessionRuntime } from "./runtime.ts";
import { spawnSupervised } from "@ace/provider-kit/process";
import type { AcpQuirks } from "./quirks/types.ts";
import { quirksName } from "./native-translator.ts";
import type { Capabilities } from "@ace/protocol";
import type { AcpSessionSupport } from "@ace/protocol";

/** A saved session the agent can no longer open: the engine starts fresh with ace's context. */
class AcpResumeUnavailable extends Error {
  readonly code = "resume_unavailable";
}

/** A saved session this agent has no way to load. */
class AcpResumeUnsupported extends Error {
  readonly code = "resume_unsupported";
}

/** The handle the addon's `AcpSessionNative` exposes. */
export interface NativeAcpHandle extends NativeSessionPort {
  outputTarget(): NonNullable<SpawnOptions["nativeOutput"]>;
  open(id: number): void;
  retryOpen(id: number): void;
  request(
    method: string,
    paramsJson: string,
    id: number,
    timeoutMs: number | null,
    defaultTimeout: boolean,
  ): void;
  send(sendJson: string, id: number): void;
  interrupt(targetJson: string, id: number): void;
  resolve(resolveJson: string, id: number): void;
  setModel(id: number, model: string): void;
  setMode(id: number, mode: string): void;
  stopTask(task: string, id: number): void;
  close(reason: string): void;
  permissionMode(): string | null | undefined;
  timer(key: string): void;
  undrain(): void;
  abandon(): void;
}

export interface NativeSessionsAddon {
  AcpSessionNative: new (
    configJson: string,
    events: (error: unknown, batch: string) => void,
  ) => NativeAcpHandle;
}

let loaded: NativeSessionsAddon | undefined;

/** The sessions addon, loaded once; absent, the open fails rather than running TypeScript. */
function addon(): NativeSessionsAddon {
  if (loaded) return loaded;
  const path = sessionsAddonPath();
  if (!existsSync(path)) throw new Error(`ACE_SESSIONS=acp needs the sessions addon at ${path}`);
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  loaded = module.exports as unknown as NativeSessionsAddon;
  return loaded;
}

/** What the native open settles with (`OpenResult::to_json`). */
interface OpenResult {
  nativeSessionId: string;
  steerViaCancel: boolean;
  mcpTransport: "http" | "stdio" | "unavailable";
  capabilities: Capabilities;
  support: AcpSessionSupport;
  rawSelectors: unknown;
  refusedOptions: string[];
}

export async function openNativeAcpSession(
  ctx: SessionContext,
  quirks: AcpQuirks,
  launch: LaunchOptions,
  runtime: SessionRuntime = { spawn: spawnSupervised, now: () => performance.now() },
): Promise<ProviderSession> {
  // The lease ends before anything here can throw (`session.ts:74`-`:77`), with the same
  // error the TypeScript session throws.
  if (ctx.signal.aborted) {
    ctx.mcp?.end();
    throw new Error("ACP session lifetime already ended");
  }
  const lease = ctx.mcp;
  const native = (() => {
    try {
      return addon();
    } catch (error) {
      lease?.end();
      throw error;
    }
  })();
  const started = runtime.now();
  const windows = (runtime.platform ?? process.platform) === "win32";
  let handle: NativeAcpHandle;
  let bridge: SessionBridge;
  let nextId = 0;
  // The core's context callbacks arrive through the bridge by name: the open's running mode
  // is not in its result, so it is cached from the callback before the open settles.
  let runningMode: string | undefined;
  // The surface's live fields: a mode or capability the agent changes mid-session is what
  // the engine reads next (`configuration.capabilities`, `permissionMode`).
  let live: ProviderSession | undefined;
  const hooksCtx = {
    ...ctx,
    ...(lease === undefined ? {} : { endMcp: () => lease.end() }),
    onPermissionMode: (mode: string) => {
      runningMode = mode;
      if (live) Object.assign(live, { permissionMode: mode });
      ctx.onPermissionMode?.(mode);
    },
    onCapabilities: (caps: Capabilities, nextSupport?: AcpSessionSupport) => {
      if (live)
        Object.assign(live, {
          effectiveCapabilities: caps,
          ...(nextSupport === undefined ? {} : { acpSupport: nextSupport }),
        });
      ctx.onCapabilities?.(caps, nextSupport);
    },
  };
  try {
    handle = new native.AcpSessionNative(
      JSON.stringify({
        threadId: ctx.threadId,
        cwd: ctx.cwd,
        kind: quirksName(quirks),
        command: quirks.command,
        args: quirks.args,
        experimental: quirks.experimental,
        clientMeta: JSON.stringify(quirks.clientMeta),
        ...(launch.version ? { version: launch.version } : {}),
        ...(launch.profile ? { profile: JSON.stringify(launch.profile) } : {}),
        ...(launch.profileFit ? { profileFit: launch.profileFit } : {}),
        ...(ctx.resume ? { resume: ctx.resume.nativeSessionId } : {}),
        ...(ctx.permissionMode ? { permissionMode: ctx.permissionMode } : {}),
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(typeof ctx.options?.["effort"] === "string" ? { effort: ctx.options["effort"] } : {}),
        ...(ctx.mcp
          ? {
              mcp: JSON.stringify({
                httpServers: ctx.mcp.httpServers,
                stdioServers: ctx.mcp.stdioServers ?? [],
                configuredServers: ctx.mcp.configuredServers ?? [],
                secrets: [...ctx.mcp.secrets],
                ...(ctx.mcp.instructions
                  ? { instructions: ctx.mcp.instructions }
                  : {
                      developerInstructions: developerInstructions(
                        quirks.provider,
                        ctx.aceMcp?.session?.() ?? {},
                      ),
                    }),
              }),
            }
          : {}),
      }),
      (_error: unknown, batch: string) => bridge.deliver(batch),
    );
  } catch (error) {
    lease?.end();
    throw error;
  }
  let spawned = false;
  let proc: ReturnType<SessionRuntime["spawn"]>;
  const hooks: BridgeHooks = {
    now: () => runtime.now(),
    started,
    schedule: (callback, ms) => (runtime.schedule ?? defaultSchedule)(ms, callback),
    timer: (key) => handle.timer(key),
    fatal: () => {
      if (!spawned) return;
      void close("shutdown").catch(() => {});
    },
    drained: () => {
      if (!spawned) return;
      closed = true;
      release();
    },
  };
  bridge = sessionBridge(hooksCtx, handle, hooks, {
    ACE_INPUT_REJECTED: InputRejected,
    ACE_STEER_TARGET_LOST: SteerTargetLost,
    ACE_ACP_RESUME_UNAVAILABLE: AcpResumeUnavailable,
    ACE_ACP_RESUME_UNSUPPORTED: AcpResumeUnsupported,
  });
  try {
    proc = runtime.spawn({
      command: launch.command,
      args: launch.args,
      cwd: ctx.cwd,
      ...(ctx.outputFlow ? { outputFlow: ctx.outputFlow } : {}),
      env: launch.env ?? {},
      name: quirks.provider,
      nativeOutput: handle.outputTarget(),
    });
  } catch (error) {
    // No child will ever report: close the session so its queue settles, then rethrow.
    handle.abandon();
    lease?.end();
    throw openingError(error, ctx, launch);
  }
  spawned = true;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let firstTree: RecordedTree | undefined;
  const trees: RecordedTree[] = [];

  const release = () => {
    lease?.end();
    ctx.signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    void close("shutdown").catch(() => {});
  };
  ctx.signal.addEventListener("abort", abort, { once: true });

  /** The facade's requests: the sign-in retry's `authenticate`, and the open itself. */
  const rpc = {
    request(
      method: string,
      params: Record<string, unknown> = {},
      options?: { timeoutMs?: number | null },
    ): Promise<unknown> {
      const id = ++nextId;
      const timeout = options?.timeoutMs ?? null;
      handle.request(method, JSON.stringify(params), id, timeout, false);
      return bridge.expect(id);
    },
  };
  const open = (): Promise<unknown> => {
    const id = ++nextId;
    handle.open(id);
    return bridge.expect(id);
  };
  /** The sign-in retry: the session request again, never a second `initialize`. */
  const retryOpen = (): Promise<unknown> => {
    const id = ++nextId;
    handle.retryOpen(id);
    return bridge.expect(id);
  };

  let opened: unknown;
  try {
    // The first attempt is the whole handshake; after `authenticate`, only the session
    // request is retried (`acp-sign-in.ts:30`), so `initialize` runs once.
    let attempts = 0;
    opened = await openWithSignIn(
      rpc,
      launch.signInMethod,
      () => (attempts++ === 0 ? open() : retryOpen()),
      ctx.signal,
    );
  } catch (error) {
    await closeAfterOpenFailure(error);
    // A resume the agent refuses keeps its own code, so the engine offers a fresh session.
    const failure =
      error instanceof AcpResumeUnavailable || error instanceof AcpResumeUnsupported
        ? { code: error.code, detail: error.message }
        : error;
    throw openingError(failure, ctx, launch);
  }
  const result = opened as OpenResult;
  // The running mode is the configuration's current one after the saved selections applied,
  // not only what the agent announced (`session.ts:522`).
  runningMode = handle.permissionMode() ?? runningMode;
  if (process.env["ACE_SESSIONS_EVIDENCE"]) evidence();
  void proc.exited.then(() => {
    closed = true;
    release();
  });

  /** The one close: the core's teardown, the stop, then every frame the child produced. */
  async function stopChild(): Promise<void> {
    if (!windows) {
      await proc.stop({ graceMs: 1000 });
      return;
    }
    // Windows has no SIGTERM for a console child: EOF is the polite stop, then the trees.
    const pid = proc.pid;
    if (pid === undefined) {
      await proc.stop({ graceMs: 1000 });
      return;
    }
    if (!firstTree) {
      firstTree = recordTree(pid);
      proc.stdin.end();
    }
    trees.push(recordTree(pid));

    await proc.stop({ graceMs: 1000 });
    for (const tree of trees) await tree.end();
  }

  /** The open's error path: the same close, so an abort and a failure stop the child once. */
  async function closeAfterOpenFailure(_error: unknown): Promise<void> {
    await close("shutdown").catch(() => {});
  }

  async function close(reason: "idle" | "user" | "shutdown"): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      // The core's teardown: the stop note, its questions cancelled, its queue rejected, the
      // lease ended. Then the gate is drained and the child stopped.
      handle.close(reason);
      handle.drain();
      try {
        await stopChild();
      } catch (error) {
        // A stop that could not be confirmed leaves the session whole but stop-only.
        closePromise = undefined;
        handle.undrain();
        throw error;
      }
      await bridge.drainedPromise;
      release();
    })();
    return closePromise;
  }

  const session: ProviderSession = {
    nativeSessionId: result.nativeSessionId,
    ...(result.steerViaCancel ? { steerViaCancel: true as const } : {}),
    effectiveCapabilities: result.capabilities,
    acpSupport: result.support,
    refusedOptions: [...result.refusedOptions],
    ...(runningMode ? { permissionMode: runningMode } : {}),
    async send(
      input: ContentPart[],
      delivery: "steer" | "queue",
      commandId?: string,
      origin?: InputSource,
      fence?: SteerFence,
    ): Promise<void> {
      // A session that drained refuses input as never taken, as today.
      if (closed) throw new InputRejected("ACP session closed");
      // E3 rule 1: the fence is checked in this synchronous step, before the call.
      assertSteerTarget(delivery, fence);
      const id = nextId + 1;
      nextId = id;
      handle.send(
        JSON.stringify({
          input,
          delivery,
          ...(commandId ? { commandId } : {}),
          ...(origin ? { origin } : {}),
          ...(fence ? { fence: { turn: fence.turn, current: fence.current() } } : {}),
        }),
        id,
      );
      await bridge.expect(id);
    },
    async interrupt(target: { agent?: string; cascade: boolean }): Promise<void> {
      const id = nextId + 1;
      nextId = id;
      handle.interrupt(
        JSON.stringify({
          ...(target.agent ? { agent: target.agent } : {}),
          cascade: target.cascade,
        }),
        id,
      );
      await bridge.expect(id);
    },
    async resolve(interaction: string, resolution: InteractionResolution): Promise<void> {
      const id = nextId + 1;
      nextId = id;
      handle.resolve(JSON.stringify({ key: interaction, resolution }), id);
      await bridge.expect(id);
    },
    async stopTask(task: string): Promise<void> {
      const id = nextId + 1;
      nextId = id;
      handle.stopTask(task, id);
      await bridge.expect(id);
    },
    async setModel(model: string): Promise<void> {
      const id = nextId + 1;
      nextId = id;
      handle.setModel(id, model);
      await bridge.expect(id);
      runningMode = handle.permissionMode() ?? runningMode;
      Object.assign(session, runningMode ? { permissionMode: runningMode } : {});
    },
    async setMode(mode: string): Promise<void> {
      const id = nextId + 1;
      nextId = id;
      handle.setMode(id, mode);
      await bridge.expect(id);
      runningMode = handle.permissionMode() ?? runningMode;
      Object.assign(session, runningMode ? { permissionMode: runningMode } : {});
    },
    close,
  };
  live = session;
  return session;
}

function defaultSchedule(ms: number, callback: () => void): () => void {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

function openingError(error: unknown, ctx: SessionContext, launch: LaunchOptions): Error {
  return new SessionOpenError(
    "ACP session opening failed",
    error,
    { env: launch.env ?? ctx.env, workspace: ctx.cwd },
    (value) => (ctx.mcp ? redactSecrets(value, ctx.mcp.secrets) : value),
  );
}

/** Lease secrets never reach the message a person sees. */
function redactSecrets(value: unknown, secrets: readonly string[]): unknown {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) if (secret) text = text.split(secret).join("[ace lease redacted]");
  return text;
}

/** The E3.0d evidence line (step 3), appended once per open the native facade made. */
function evidence(): void {
  const path = process.env["ACE_SESSIONS_EVIDENCE"];
  if (!path) return;
  appendFileSync(
    path,
    `${JSON.stringify({ provider: "acp", backend: "native", pid: process.pid })}\n`,
  );
}
