// SPDX-License-Identifier: Apache-2.0
/**
 * The native Codex facade behind `ACE_SESSIONS=codex` (E3-codex.5). It is `openCodexSession` with
 * the per-frame half removed: the Rust session frames, redacts, inspects, tracks controls,
 * discovers threads, serves the catalog and settles requests through the shared bridge (E3.0c).
 * This file keeps the open-time composition (discovery, capabilities, tool facts, the thread's
 * start/resume/fork) and owns each host's process. Every `ProviderSession` method is one binding
 * call plus `bridge.expect`.
 */

import { appendFileSync, existsSync } from "node:fs";
import { accessModeOffers, codexAccessAvailable } from "@ace/provider-kit/access-modes";
import { requireReadableMinimum } from "@ace/provider-kit/cli-requirements";
import { sessionsAddonPath } from "@ace/provider-kit/native-switches";
import {
  sessionBridge,
  type BridgeHooks,
  type NativeSessionPort,
  type SessionBridge,
} from "@ace/provider-kit/native-session-bridge";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import type { SpawnOptions, SupervisedProcess } from "@ace/provider-kit/process";
import { codexInjection } from "@ace/mcp-server";
import {
  InputRejected,
  SteerTargetLost,
  assertSteerTarget,
  type InputSource,
  type SteerFence,
} from "@ace/engine-api";
import type { ContentPart, InteractionResolution, PermissionMode } from "@ace/protocol";
import { codexCapabilities } from "./capabilities.ts";
import { configuredTurnPolicy } from "./default-permissions.ts";
import type { CodexHostPool } from "./host-pool.ts";
import { CodexInteractionUnavailable } from "./interaction-lifecycle.ts";
import { codexThreadPolicy } from "./permission-policy.ts";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts";
import { runtime, type CodexRuntime } from "./runtime.ts";
import { CodexSelectionOptions } from "./selection.ts";
import type { CodexSessionContext } from "./session-context.ts";
import type { CodexOptions } from "./session.ts";
import { codexShellEnvConfig } from "./shell-env.ts";
import { unloadClosedThreads } from "./thread-lease.ts";
import { z } from "zod";
import { codexToolListing } from "./tool-search.ts";

/** One request as the session reads it, from the addon. */
type FenceJson = { turn?: string | undefined; current: boolean };

interface NativeCodexChannel extends NativeSessionPort {
  needsSpawn(): boolean;
  spawnTarget(): NonNullable<SpawnOptions["nativeOutput"]>;
  spawned(pid: number | null): void;
  ready(): number;
  attached(root: string, model: string, selectionJson: string, permissionMode: string | null): void;
  permissionModePort(present: boolean): void;
  note(json: string): void;
  request(method: string, paramsJson: string, timeoutMs: number | null): number;
  send(
    operation: number,
    partsJson: string,
    delivery: "steer" | "queue",
    commandId: string | undefined,
    origin: InputSource | undefined,
    fenceJson: string | undefined,
    userMessageId: string,
  ): void;
  interrupt(operation: number, agent: string | null, cascade: boolean): void;
  stopTask(operation: number, task: string): void;
  resolve(
    operation: number,
    key: string,
    resolutionJson: string,
    userMessageId: string,
    interactionId: string | null,
    model: string,
  ): void;
  configure(operation: number, selectionJson: string, model: string | null, reopen: boolean): void;
  close(operation: number, reason: string): void;
  failOpen(operation: number): void;
  abort(reason: string): void;
  timer(key: string, now: number): void;
  toolFacts(operation: number, model: string | null): void;
  readRoot(operation: number): void;
  rateLimits(): void;
  catalogStart(): void;
  launchMode(operation: number, modeJson: string): void;
  launchFailed(operation: number, message: string): void;
  mcpStatus(operation: number): void;
  mcpAdd(operation: number, name: string, inputJson: string): void;
  mcpReplace(operation: number): void;
  mcpReconnect(operation: number): void;
  mcpToggle(operation: number, name: string, on: boolean): void;
  goal(operation: number, changeJson: string): void;
  clearGoal(operation: number): void;
}

interface NativePoolHandle {
  open(key: string, dedicated: boolean, configJson: string, events: unknown): NativeCodexChannel;
  stopFailed(key: string, message: string): void;
  stopConfirmed(key: string): void;
  hostTimer(hostId: number, key: string): void;
  close(): void;
}

export interface NativeCodexAddon {
  CodexPoolNative: new (
    idleMs: number | null,
    stop: (error: unknown, json: string) => void,
    timer: (error: unknown, json: string) => void,
  ) => NativePoolHandle;
}

let loaded: NativeCodexAddon | undefined;

/** The sessions addon, loaded once; absent, the open fails rather than running TypeScript. */
function addon(): NativeCodexAddon {
  if (loaded) return loaded;
  const path = sessionsAddonPath();
  if (!existsSync(path)) throw new Error(`ACE_SESSIONS=codex needs the sessions addon at ${path}`);
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  loaded = module.exports as unknown as NativeCodexAddon;
  return loaded;
}

/** A native pool per TypeScript pool: the tests that share one pool share one native pool. */
const nativePools = new WeakMap<CodexHostPool, NativePool>();

class NativePool {
  readonly native: NativePoolHandle;
  readonly #procs = new Map<string, SupervisedProcess>();
  readonly #timers = new Map<string, () => void>();
  readonly #graceMs: number;
  readonly #schedule: (callback: () => void, ms: number) => () => void;

  constructor(
    native: NativeCodexAddon,
    idleMs: number | null,
    graceMs: number,
    schedule: (callback: () => void, ms: number) => () => void,
  ) {
    this.#graceMs = graceMs;
    this.#schedule = schedule;
    this.native = new native.CodexPoolNative(
      idleMs,
      (_error, json) => {
        void this.#stop(json);
      },
      (_error, json) => this.#timer(json),
    );
  }

  /** A host timer no tenant carries: the idle app-server's retirement, mostly. */
  #timer(json: string): void {
    const { host, key, ms } = JSON.parse(json) as {
      host: number;
      key: string;
      ms: number | null;
    };
    const id = `${host}:${key}`;
    const previous = this.#timers.get(id);
    if (previous !== undefined) {
      this.#timers.delete(id);
      previous();
    }
    if (ms === null) return;
    this.#timers.set(
      id,
      this.#schedule(() => {
        this.#timers.delete(id);
        this.native.hostTimer(host, key);
      }, ms),
    );
  }

  open(key: string, dedicated: boolean, config: unknown, events: unknown): NativeCodexChannel {
    return this.native.open(key, dedicated, JSON.stringify(config), events);
  }

  adopt(key: string, proc: SupervisedProcess): void {
    this.#procs.set(key, proc);
    void proc.exited.then(() => {
      if (this.#procs.get(key) === proc) this.#procs.delete(key);
    });
  }

  async #stop(json: string): Promise<void> {
    const { key } = JSON.parse(json) as { key: string; reason: string };
    const proc = this.#procs.get(key);
    if (!proc) {
      this.native.stopFailed(key, "Codex app-server is not this pool's");
      return;
    }
    try {
      await proc.stop({ graceMs: this.#graceMs });
      this.native.stopConfirmed(key);
    } catch (error) {
      this.native.stopFailed(key, error instanceof Error ? error.message : String(error));
    }
  }

  async close(): Promise<void> {
    const exited = [...this.#procs.values()].map((proc) => proc.exited);
    for (const cancel of this.#timers.values()) cancel();
    this.#timers.clear();
    this.native.close();
    await Promise.allSettled(exited);
  }
}

/** The spawn key: everything fixed at spawn, so sessions on one account share one process. */
function spawnKey(ctx: CodexSessionContext, env: NodeJS.ProcessEnv | undefined): string {
  const entries = Object.entries(env ?? {})
    .filter(([name, value]) => value !== undefined && name !== "ACE_MCP_BEARER_TOKEN")
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([
    ctx.executable ?? null,
    ctx.builtinSkills?.args ?? [],
    ctx.toolConfigArgs ?? [],
    entries,
  ]);
}

async function discover(
  ctx: CodexSessionContext,
  io: CodexRuntime,
  options: CodexOptions,
): Promise<string> {
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
  requireReadableMinimum("codex", cli.version);
  return cli.path;
}

export async function openNativeCodexSession(
  ctx: CodexSessionContext,
  options: CodexOptions = {},
  /** Tests inject a stale addon; production always loads `addon`. */
  load: () => NativeCodexAddon = addon,
): Promise<import("@ace/engine-api").ProviderSession> {
  ctx.signal.throwIfAborted();
  // The addon first: a missing one must not spawn or discover anything.
  const native = load();
  const io = { ...runtime, ...options.runtime };
  let permissionMode: PermissionMode | null = ctx.permissionMode ?? null;
  let selectedOptions = CodexSelectionOptions.parse(ctx.options ?? {});
  let model = ctx.model ?? "";
  const command = await discover(ctx, io, options);
  const scope = io.sessionId();
  const started = io.now();
  const pool = options.hosts
    ? nativePoolFor(native, options.hosts, io)
    : new NativePool(native, 0, io.stopGraceMs, (callback, ms) => io.schedule(callback, ms));
  const key = spawnKey(ctx, ctx.env ?? options.discovery?.env);
  let root = "";
  let bridge: SessionBridge;
  let channel: NativeCodexChannel;
  let proc: SupervisedProcess | undefined;
  channel = pool.open(
    key,
    !options.hosts,
    {
      scope,
      started,
      cwd: ctx.cwd,
      ...(ctx.aceMcp ? { bearer: ctx.aceMcp.bearer } : {}),
      workspace: ctx.cwd,
      home: io.homeDir(),
      hostname: hostName(),
      // The daemon's own switches are operational, not identity: a literal
      // `ACE_SESSIONS=codex` must not become `<ENV>` in the exit evidence.
      env: Object.entries(ctx.env ?? {})
        .filter(([name, value]) => typeof value === "string" && !operationalSwitch(name))
        .map(([name, value]) => [name, value as string] as [string, string]),
    },
    (_error: unknown, batch: string) => bridge.deliver(batch),
  );
  const hooks: BridgeHooks = {
    now: () => io.now(),
    started,
    schedule: (callback, ms) => io.schedule(callback, ms),
    timer: (timerKey) => channel.timer(timerKey, io.now()),
    fatal: () => {
      void close("shutdown").catch(stopFailed);
    },
    drained: () => {
      drained = true;
    },
    port: (name, json) => {
      if (name === "stop") return;
      if (name === "launch") {
        const { operation } = JSON.parse(json) as { operation: number; thread: string };
        if (!ctx.getPermissionMode) {
          channel.launchMode(operation, "null");
          return;
        }
        void ctx.getPermissionMode().then(
          (mode) => channel.launchMode(operation, JSON.stringify(mode)),
          (error: unknown) =>
            channel.launchFailed(operation, error instanceof Error ? error.message : String(error)),
        );
      }
    },
  };
  bridge = sessionBridge(ctx, channel, hooks, {
    ACE_INPUT_REJECTED: InputRejected,
    ACE_STEER_TARGET_LOST: SteerTargetLost,
    ACE_CODEX_FAILED: Error,
    interaction_unavailable: CodexInteractionUnavailable,
  });
  let closed = false;
  let drained = false;
  let closePromise: Promise<void> | undefined;
  let nextOperation = 1;
  const operation = () => nextOperation++;
  /** Register the settlement before the binding call: a synchronous refusal or
   * the terminal `Drained` can otherwise beat the pending promise. */
  /** New work after the exit/drain is the session's own refusal, not the bridge's. */
  const guard = () => {
    if (closed || drained) throw new Error("Codex session is closed");
  };
  const settle = <T = unknown>(
    id: number,
    run: () => void,
    onClosed: () => Error = () => new Error("Codex session is closed"),
  ): Promise<T> => {
    const pending = (bridge.expect(id) as Promise<T>).catch((error: unknown) => {
      // The terminal barrier rejects whatever is still pending; the session's
      // own refusal is the answer a caller expects after it.
      if (error instanceof Error && error.message === "session closed") throw onClosed();
      throw error;
    });
    run();
    return pending;
  };
  const request = async (
    method: string,
    params: unknown,
    timeoutMs: number | null = 30_000,
  ): Promise<unknown> => bridge.expect(channel.request(method, JSON.stringify(params), timeoutMs));
  const release = () => {
    ctx.signal.removeEventListener("abort", abort);
  };
  const stopFailed = (error: unknown) =>
    channel.note(
      JSON.stringify({
        type: "stop-failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  function close(reason: "idle" | "user" | "shutdown"): Promise<void> {
    if (closePromise) return closePromise;
    // A session whose pipes already closed is gone: a later close only releases.
    if (drained) {
      release();
      return Promise.resolve();
    }
    closed = true;
    const id = operation();
    closePromise = settle(id, () => channel.close(id, reason)).then(
      async () => {
        // The terminal barrier: every frame, callback and settle arrived.
        await bridge.drainedPromise;
        release();
      },
      (error: unknown) => {
        closePromise = undefined;
        throw error;
      },
    );
    return closePromise;
  }
  function abort(): void {
    void close("shutdown").catch(stopFailed);
  }
  ctx.signal.addEventListener("abort", abort, { once: true });
  try {
    channel.permissionModePort(Boolean(ctx.getPermissionMode));
    if (channel.needsSpawn()) {
      proc = io.spawn({
        command,
        args: [
          ...(ctx.builtinSkills?.args ?? []),
          ...(ctx.toolConfigArgs ?? []),
          "app-server",
          ...unloadClosedThreads,
        ],
        // A shared process outlives any one workspace; threads carry their own cwd.
        cwd: options.hosts ? io.homeDir() : ctx.cwd,
        name: "ace-codex",
        maxLineBytes: 16 * 1024 * 1024,
        // Never called on a diverted child: the Rust stderr framer notes its own drops.
        onStderrLineDropped: () => {},
        elideStdout: { holdBytes: 16 * 1024, textBytes: 16 * 1024 * 1024 },
        env: { ...(ctx.env ?? options.discovery?.env), ACE_MCP_BEARER_TOKEN: undefined },
        ...(ctx.builtinSkills?.lease ? { lease: ctx.builtinSkills.lease } : {}),
        nativeOutput: channel.spawnTarget(),
      });
      pool.adopt(key, proc);
      channel.spawned(proc.pid ?? null);
    }
    await bridge.expect(channel.ready());
    if (ctx.signal.aborted) throw ctx.signal.reason;
    // Independent of the profile catalog: both requests are in flight together.
    const configured =
      permissionMode === null && ctx.resetPermissions
        ? request("config/read", { cwd: ctx.cwd, includeLayers: false })
        : undefined;
    void configured?.catch(() => {});
    try {
      const listing = PermissionProfiles.parse(
        await request("permissionProfile/list", { cwd: ctx.cwd, limit: 256 }),
      );
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
    let injection: ReturnType<typeof codexInjection> | undefined;
    if (ctx.aceMcp) {
      const factsOperation = operation();
      channel.toolFacts(factsOperation, ctx.model ?? null);
      const facts = await bridge.expect(factsOperation);
      injection = codexInjection({
        ...ctx.aceMcp,
        listing: codexToolListing(facts as import("./tool-search.ts").CodexToolFacts),
      });
    }
    const threadPolicy: Pick<
      ThreadStartParams,
      "permissions" | "approvalPolicy" | "approvalsReviewer" | "config"
    > = configured
      ? configuredTurnPolicy(await configured)
      : codexThreadPolicy(permissionMode, ctx.cwd);
    const shellEnv = codexShellEnvConfig(ctx.agentEnv);
    const params = {
      cwd: ctx.cwd,
      ...threadPolicy,
      ...(injection || Object.keys(shellEnv).length
        ? { config: { ...threadPolicy.config, ...injection?.config, ...shellEnv } }
        : {}),
      ...(injection ? { developerInstructions: injection.developerInstructions } : {}),
      ...(ctx.model ? { model: ctx.model } : {}),
    } satisfies ThreadStartParams;
    const result = asObject(
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
    root = asString(asObject(result["thread"])["id"]);
    if (!root) throw new Error("Codex did not return a thread id");
    model = asString(result["model"], model);
    channel.attached(root, model, JSON.stringify({ ...selectedOptions }), permissionMode);
    // An existing thread's history, in bounded pages, before anything can act on it.
    if (ctx.fork || ctx.resume) {
      const readOperation = operation();
      channel.readRoot(readOperation);
      await bridge.expect(readOperation);
    }
    if (ctx.options !== undefined)
      await request("thread/settings/update", {
        threadId: root,
        effort: null,
        summary: null,
        serviceTier: null,
        ...selectedOptions,
      });
    channel.note(JSON.stringify({ event: "session-scope", scope }));
    channel.catalogStart();
    channel.note(JSON.stringify({ event: "permission-turn-policy-supported" }));
    channel.rateLimits();
    const evidence = process.env.ACE_SESSIONS_EVIDENCE;
    if (evidence !== undefined)
      appendFileSync(
        evidence,
        `${JSON.stringify({ provider: "codex", backend: "native", pid: process.pid })}\n`,
      );
  } catch (error) {
    if (!closePromise) {
      const id = operation();
      await settle(id, () => channel.failOpen(id)).catch(() => {});
    }
    release();
    throw error;
  }
  return {
    get nativeSessionId() {
      return root;
    },
    get sessionConfirmed() {
      return true;
    },
    async configure(selection) {
      if (closed || drained) throw new Error("Codex session is closed");
      const executionOptions = CodexSelectionOptions.parse(selection.options);
      const id = operation();
      const outcome = await settle(id, () =>
        channel.configure(
          id,
          JSON.stringify({ ...executionOptions }),
          selection.model ?? null,
          Boolean(ctx.aceMcp && (selection.model ?? "") !== (ctx.model ?? "")),
        ),
      );
      if (outcome === "reopen") return "reopen" as const;
      model = selection.model ?? "";
      selectedOptions = executionOptions;
    },
    close: (reason) => close(reason),
    mcp: {
      appliesNextTurn: true,
      async status() {
        guard();
        const id = operation();
        return settle<{ name: string; status: string }[]>(id, () => channel.mcpStatus(id));
      },
      async add(name, input) {
        guard();
        const id = operation();
        await settle(id, () => channel.mcpAdd(id, name, JSON.stringify(input)));
      },
      async replace() {
        throw new Error("Codex does not support replacing live MCP servers");
      },
      async reconnect() {
        guard();
        const id = operation();
        await settle(id, () => channel.mcpReconnect(id));
      },
      async enable(name) {
        guard();
        const id = operation();
        await settle(id, () => channel.mcpToggle(id, name, true));
      },
      async disable(name) {
        guard();
        const id = operation();
        await settle(id, () => channel.mcpToggle(id, name, false));
      },
    },
    async setGoal(change) {
      guard();
      const id = operation();
      await settle(id, () => channel.goal(id, JSON.stringify(change)));
    },
    async clearGoal() {
      guard();
      const id = operation();
      await settle(id, () => channel.clearGoal(id));
    },
    async send(
      input: ContentPart[],
      delivery: "steer" | "queue",
      commandId?: string,
      origin?: InputSource,
      fence?: SteerFence,
    ) {
      guard();
      assertSteerTarget(delivery, fence);
      const id = operation();
      const fenceJson: FenceJson | undefined =
        fence === undefined ? undefined : { current: fence.current(), turn: fence.turn };
      await settle(id, () =>
        channel.send(
          id,
          JSON.stringify(input),
          delivery,
          commandId,
          origin,
          fenceJson === undefined ? undefined : JSON.stringify(fenceJson),
          io.userMessageId(),
        ),
      );
    },
    async interrupt(target) {
      guard();
      const id = operation();
      await settle(id, () => channel.interrupt(id, target.agent ?? null, target.cascade));
    },
    async stopTask(task) {
      guard();
      const id = operation();
      await settle(id, () => channel.stopTask(id, task));
    },
    async resolve(interaction, resolution: InteractionResolution) {
      if (closed || drained) throw new CodexInteractionUnavailable(interaction);
      const id = operation();
      await settle(
        id,
        () =>
          channel.resolve(
            id,
            interaction,
            JSON.stringify(resolution),
            io.userMessageId(),
            ctx.interactionId?.(interaction) ?? null,
            model,
          ),
        () => new CodexInteractionUnavailable(interaction),
      );
    },
  };
}

function nativePoolFor(
  native: NativeCodexAddon,
  pool: CodexHostPool,
  io: CodexRuntime,
): NativePool {
  const existing = nativePools.get(pool);
  if (existing) return existing;
  const created = new NativePool(native, pool.idleMs, io.stopGraceMs, (callback, ms) =>
    io.schedule(callback, ms),
  );
  nativePools.set(pool, created);
  pool.native = { close: async () => created.close() };
  return created;
}

const PermissionProfiles = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        description: z.string().max(2048).nullish(),
        allowed: z.boolean(),
      }),
    )
    .max(256),
});

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function hostName(): string {
  return process.env.HOSTNAME ?? "";
}

/** ace's own switches and level knobs: read by the daemon, never redacted. */
function operationalSwitch(name: string): boolean {
  return name.startsWith("ACE_") && !/(TOKEN|SECRET|KEY|PASSWORD|BEARER)/.test(name);
}
