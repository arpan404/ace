// SPDX-License-Identifier: Apache-2.0
/**
 * The native Pi facade behind `ACE_SESSIONS=pi` (E3-pi.2). It is `openPiSession` with the
 * per-line half replaced: the Rust session frames, redacts, inspects, tracks dialogs and
 * deadlines, and settles requests through the shared bridge (E3.0c). This file keeps the
 * open-time and control composition (discovery, MCP configuration, references, launch
 * arguments, `verifyExtension`, `restore`, `fork`, `rollback`) and owns the stop plan.
 */

import { appendFileSync, existsSync } from "node:fs";
import { nativeCommandInputs } from "@ace/commands/invocation";
import { fileURLToPath } from "node:url";
import { privateMcpConfig, AceMcpConnectionSchema } from "@ace/mcp-server";
import type { ContentPart, InteractionResolution } from "@ace/protocol";
import {
  assertSteerTarget,
  InputRejected,
  type InputSource,
  type SessionContext,
  type SteerFence,
} from "@ace/engine-api";
import { requireReadableMinimum } from "@ace/provider-kit/cli-requirements";
import { sessionsAddonPath } from "@ace/provider-kit/native-switches";
import {
  sessionBridge,
  type BridgeHooks,
  type NativeSessionPort,
  type SessionBridge,
} from "@ace/provider-kit/native-session-bridge";
import type { SpawnOptions } from "@ace/provider-kit/process";
import { recordTree, type RecordedTree } from "@ace/provider-kit/tree-stop";
import { piLaunchArgs } from "./launch-args.ts";
import { piNative } from "@ace/provider-kit/access-modes";
import { PiCommandRefused } from "./rpc.ts";
import { runtime, type PiRuntime } from "./runtime.ts";
import { Cancelled, State, list, obj, str } from "./native.ts";
import { piInput } from "./input.ts";
import { dialogResponse } from "./dialogs.ts";
import {
  loadSessionReference,
  saveSessionReference,
  sessionReferenceDirectory,
} from "./session-references.ts";
import {
  checkedSessionReference,
  encodeSessionReference,
  type SessionReference,
} from "./session-header.ts";
import { PiHistoryError } from "./history-errors.ts";
import { requireDurableFork } from "./fork-admission.ts";
import type { PiOptions, PiSession } from "./session.ts";

interface NativePiHandle extends NativeSessionPort {
  outputTarget(): NonNullable<SpawnOptions["nativeOutput"]>;
  request(command: string, paramsJson: string, id: number): void;
  write(dataJson: string, id: number, resumeAfter: boolean): void;
  note(json: string): void;
  timer(key: string): void;
  peekDialog(idJson: string): string | null | undefined;
  takeDialog(idJson: string): boolean;
  dialogCount(): number;
  expectRollback(id: string): void;
  rollbackResult(): boolean | undefined;
  clearRollback(): void;
  undrain(): void;
  abandon(): void;
}

interface NativeSessionsAddon {
  PiSessionNative: new (
    configJson: string,
    events: (error: unknown, batch: string) => void,
  ) => NativePiHandle;
}

let loaded: NativeSessionsAddon | undefined;

/** The sessions addon, loaded once; absent, the open fails rather than running TypeScript. */
function addon(): NativeSessionsAddon {
  if (loaded) return loaded;
  const path = sessionsAddonPath();
  if (!existsSync(path)) throw new Error(`ACE_SESSIONS=pi needs the sessions addon at ${path}`);
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  loaded = module.exports as unknown as NativeSessionsAddon;
  return loaded;
}

export async function openNativePiSession(
  ctx: SessionContext,
  options: PiOptions = {},
): Promise<PiSession> {
  ctx.signal.throwIfAborted();
  const io = { ...runtime, ...options.runtime };
  // Windows has no SIGTERM for a console child: closing stdin is the polite stop there.
  const windows = (io.platform ?? process.platform) === "win32";
  const cli =
    (ctx.executable ? undefined : options.cli) ??
    (await io.discover({
      ...((ctx.executable ?? options.executable)
        ? { executable: ctx.executable ?? options.executable }
        : {}),
      ...(ctx.env ? { env: ctx.env } : {}),
      signal: ctx.signal,
    }));
  if (!cli.installed || !cli.path)
    throw new Error("Pi is not installed. Install it or configure its path.");
  requireReadableMinimum("pi", cli.version);
  const referenceDir = sessionReferenceDirectory(options.sessionReferenceDir);
  const resume = ctx.resume
    ? await loadSessionReference(referenceDir, ctx.resume.nativeSessionId)
    : undefined;
  const lifetime = new AbortController();
  const controlSecret = io.secret();
  // The daemon's existing session lease owns capabilities and revocation. Reuse it.
  const lease = ctx.aceMcp
    ? {
        ...AceMcpConnectionSchema.parse({ url: ctx.aceMcp.url, bearer: ctx.aceMcp.bearer }),
        end() {},
      }
    : options.openMcp?.(ctx, lifetime.signal);
  const args = [
    "--mode",
    "rpc",
    "-e",
    fileURLToPath(new URL("./extension.ts", import.meta.url)),
    ...(ctx.model ? ["--model", ctx.model] : []),
    ...piLaunchArgs(ctx.permissionMode, ctx.options?.["effort"]),
    // ace's shipped skills, beside the person's own (Pi lists every skill directory it gets).
    ...(ctx.builtinSkills?.directories ?? []).flatMap((directory) => ["--skill", directory]),
  ];
  let configuration: ReturnType<typeof privateMcpConfig>;
  try {
    configuration = privateMcpConfig(
      JSON.stringify({
        controlSecret,
        ...(lease ? { mcp: { url: lease.url, bearer: lease.bearer } } : {}),
        // Read-only keeps `ace_*` in Pi's allowlist; the extension then offers only read tools.
        ...(ctx.permissionMode === piNative.readOnly ? { readOnly: true } : {}),
      }),
      ctx.cwd,
    );
  } catch (error) {
    lifetime.abort();
    lease?.end();
    throw error;
  }
  const env = {
    ...ctx.env,
    // One Pi process per session: its bash tool inherits the agent's variables (ADR 0178 §10).
    ...ctx.agentEnv,
    ACE_PI_SESSION_FILE: configuration.path,
    ACE_PI_CONTROL_SECRET: undefined,
    ACE_PI_MCP_URL: undefined,
    ACE_PI_MCP_BEARER: undefined,
  };
  let bridge: SessionBridge;
  const handle = new (addon().PiSessionNative)(
    JSON.stringify({
      control_secret: controlSecret,
      ...(lease ? { lease_bearer: lease.bearer } : {}),
    }),
    (_error: unknown, batch: string) => bridge.deliver(batch),
  );
  let spawned = false;
  let proc: ReturnType<PiRuntime["spawn"]>;
  const hooks: BridgeHooks = {
    now: () => io.now(),
    started: 0,
    schedule: (callback, ms) => io.schedule(callback, ms),
    timer: (key) => handle.timer(key),
    fatal: () => {
      if (!spawned) return;
      fatal();
    },
    drained: () => {
      if (!spawned) return;
      void onDrained();
    },
  };
  bridge = sessionBridge(ctx, handle, hooks, {
    ACE_PI_COMMAND_REFUSED: PiCommandRefused,
    ACE_PI_UNCERTAIN: Error,
  });
  try {
    proc = io.spawn({
      command: cli.path,
      args,
      cwd: ctx.cwd,
      env,
      name: "ace-pi",
      maxLineBytes: 1024 * 1024,
      // Never called on a diverted child: the Rust stderr framer notes its own drops.
      onStderrLineDropped: () => {},
      // Pi echoes every image in message_end/agent_end; their bytes never count toward a line.
      elideStdout: { holdBytes: 16 * 1024, textBytes: 1024 * 1024 },
      nativeOutput: handle.outputTarget(),
    });
  } catch (error) {
    // No child will ever report: close the wire, settle through the queue, clean up, rethrow.
    handle.abandon();
    configuration.remove();
    lifetime.abort();
    lease?.end();
    throw error;
  }
  spawned = true;
  const started = io.now();
  hooks.started = started;
  let nativeId = "",
    nativeFile = "",
    closed = false,
    closing = false,
    deliberate = false,
    control = false;
  let nextId = 0;
  let closePromise: Promise<void> | undefined;
  let firstTree: RecordedTree | undefined;
  const trees: RecordedTree[] = [];
  const extensionPath = fileURLToPath(new URL("./extension.ts", import.meta.url));
  const release = () => {
    configuration.remove();
    lifetime.abort();
    lease?.end();
    ctx.signal.removeEventListener("abort", abort);
  };
  /** A close nobody awaits: its failure is noted here; an awaited close still rejects with it. */
  const stopFailed = (error: unknown) =>
    handle.note(
      JSON.stringify({
        event: "stop-failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  function fatal(): void {
    if (!spawned) return;
    void close("shutdown", false).catch(stopFailed);
  }
  async function onDrained(): Promise<void> {
    const exit = await proc.exited;
    ctx.onExit({ deliberate, message: `Pi process ${exit.reason}, code ${exit.code}` });
  }
  const rpc = {
    request(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
      const id = ++nextId;
      try {
        handle.request(command, JSON.stringify(params), id);
      } catch (error) {
        return Promise.reject(
          new PiCommandRefused(error instanceof Error ? error.message : String(error)),
        );
      }
      return bridge.expect(id);
    },
    write(data: Record<string, unknown>): Promise<void> {
      const id = ++nextId;
      try {
        handle.write(JSON.stringify(data), id, false);
      } catch (error) {
        return Promise.reject(
          new PiCommandRefused(error instanceof Error ? error.message : String(error)),
        );
      }
      return bridge.expect(id) as Promise<void>;
    },
  };
  const verifyExtension = async () => {
    const commands = list(obj(await rpc.request("get_commands")).commands);
    if (
      !commands.some((value) => {
        const c = obj(value);
        return (
          c.name === "ace-rollback" &&
          c.source === "extension" &&
          str(obj(c.sourceInfo).path) === extensionPath
        );
      })
    )
      throw new Error("ace Pi extension did not load");
  };
  const checkOpen = () => {
    if (closed) throw new Error("Pi session closed");
    ctx.signal.throwIfAborted();
  };
  /** resolve() after a failed stop: stop-only, so no dialog answer is ever written. */
  const checkWritable = () => {
    if (closed || closing) throw new Error("Pi session closed");
    ctx.signal.throwIfAborted();
  };
  const check = () => {
    checkOpen();
    if (control) throw new Error("Pi history operation in progress");
  };
  const idle = async () => {
    const state = State.parse(await rpc.request("get_state"));
    if (
      state.isStreaming ||
      state.isCompacting ||
      state.pendingMessageCount ||
      handle.dialogCount()
    )
      throw new PiHistoryError("idle");
    return state;
  };
  async function restore(reference: SessionReference): Promise<void> {
    await checkedSessionReference(encodeSessionReference(reference));
    const result = Cancelled.parse(
      await rpc.request("switch_session", { sessionPath: reference.path }),
    );
    if (result.cancelled) throw new PiHistoryError("cancelledSwitch");
    const state = State.parse(await rpc.request("get_state"));
    if (state.sessionFile !== reference.path || state.sessionId !== reference.id)
      throw new PiHistoryError("identity");
    await checkedSessionReference(encodeSessionReference(reference));
  }
  async function savedNativeReference(): Promise<string> {
    const state = State.parse(await rpc.request("get_state"));
    const reference = encodeSessionReference({ path: state.sessionFile, id: state.sessionId });
    await checkedSessionReference(reference);
    return saveSessionReference(referenceDir, { path: state.sessionFile, id: state.sessionId });
  }
  /** The stop plan, composed so a retry keeps the first attempt's recorded trees. */
  async function stopProcess(): Promise<void> {
    if (!windows) {
      await proc.stop({ graceMs: 1000 });
      return;
    }
    if (proc.pid !== undefined) {
      if (firstTree === undefined) {
        firstTree = recordTree(proc.pid);
        trees.push(firstTree);
        // The polite Windows stop: EOF, then taskkill for whatever the job missed.
        proc.stdin.end();
      } else {
        // A new snapshot may name descendants started since; no snapshot is dropped.
        trees.push(recordTree(proc.pid));
      }
    }
    await proc.stop({ graceMs: 1000 });
    for (const tree of trees) await tree.end();
  }
  function close(_reason: "idle" | "user" | "shutdown", expected = true): Promise<void> {
    if (closePromise) return closePromise;
    const previous = deliberate;
    closing = true;
    deliberate = expected;
    // The cancellation of ADR 0223 §7 rule 4: read on to EOF, still queueing every frame.
    handle.drain();
    closePromise = (async () => {
      try {
        await stopProcess();
      } catch (error) {
        // The session is then stop-only, not usable: no write follows a failed stop.
        closePromise = undefined;
        deliberate = previous;
        handle.undrain();
        throw error;
      }
      // Every frame the child produced has been delivered before this resolves.
      await bridge.drainedPromise;
      release();
    })();
    return closePromise;
  }
  function abort(): void {
    void close("shutdown").catch(stopFailed);
  }
  ctx.signal.addEventListener("abort", abort, { once: true });
  // A session that exits is stopping too, so a failure here is noted like a close's.
  void proc.exited
    .then(() => {
      closed = true;
      release();
    })
    .catch(stopFailed);
  try {
    handle.note(JSON.stringify({ type: "started", processId: io.processKey() }));
    await verifyExtension();
    if (resume) await restore(resume);
    const state = State.parse(await rpc.request("get_state"));
    nativeFile = state.sessionFile;
    nativeId = await saveSessionReference(referenceDir, {
      path: state.sessionFile,
      id: state.sessionId,
    });
    ctx.signal.throwIfAborted();
    // E3.0d step 3: one line per successful native open, so the bench can prove the path.
    const evidence = process.env.ACE_SESSIONS_EVIDENCE;
    if (evidence !== undefined)
      appendFileSync(
        evidence,
        `${JSON.stringify({ provider: "pi", backend: "native", pid: process.pid })}\n`,
      );
  } catch (error) {
    // A child exists here, so its `close` (or the cutoff) brings `Drained` after the stop.
    if (!closePromise) {
      deliberate = false;
      await stopProcess();
      await bridge.drainedPromise;
    }
    await close("shutdown", false);
    throw error;
  }
  return {
    ...(ctx.instanceId ? { instanceId: ctx.instanceId } : {}),
    get nativeSessionId() {
      return nativeId;
    },
    get nativeSessionFile() {
      return nativeFile;
    },
    async send(
      input: ContentPart[],
      delivery: "steer" | "queue",
      _commandId?: string,
      origin?: InputSource,
      fence?: SteerFence,
    ) {
      // Pi took none of this send until a prompt is written and not refused.
      let requested = false;
      let accepted = 0;
      try {
        check();
        if (origin === "ace") {
          const content = piInput(input).message;
          requested = true;
          await rpc.request("prompt", {
            message: `/ace-context ${controlSecret} ${Buffer.from(content).toString("base64")}`,
          });
          return;
        }
        // Validate every admission before the first one can reach the harness.
        const inputs = nativeCommandInputs(input).map(piInput);
        for (const content of inputs) {
          // Before the first prompt only: once one is taken, the rest belong with it.
          if (accepted === 0) assertSteerTarget(delivery, fence);
          requested = true;
          await rpc.request("prompt", {
            ...content,
            streamingBehavior: delivery === "steer" ? "steer" : "followUp",
          });
          accepted++;
        }
      } catch (error) {
        if (error instanceof InputRejected && accepted === 0) throw error;
        if (accepted === 0 && (!requested || error instanceof PiCommandRefused))
          throw new InputRejected(error instanceof Error ? error.message : String(error), {
            cause: error,
          });
        throw error;
      }
    },
    async interrupt(target) {
      check();
      if (target.agent && target.agent !== (ctx.rootKey ?? "root"))
        throw new Error("Pi has no native child interrupt");
      await rpc.request("clear_queue");
      await rpc.request("abort");
      await rpc.request("abort_bash");
    },
    async resolve(id: string, resolution: InteractionResolution) {
      checkWritable();
      const key = JSON.stringify(id);
      const dialog = handle.peekDialog(key);
      if (dialog === undefined || dialog === null)
        throw new Error("Pi dialog is no longer pending");
      // Validate before reserving, so a bad answer leaves the dialog pending and untouched.
      const response = dialogResponse(JSON.parse(dialog), resolution);
      // Reserve before writing so concurrent devices cannot answer twice.
      if (!handle.takeDialog(key)) throw new Error("Pi dialog is no longer pending");
      const writeId = ++nextId;
      try {
        handle.write(JSON.stringify(response), writeId, true);
        await bridge.expect(writeId);
      } catch (error) {
        fatal();
        throw error;
      }
    },
    async stopTask() {
      throw new Error("Pi has no individual native background-task control");
    },
    async fork(entryId) {
      check();
      control = true;
      try {
        const source = await idle();
        const sourceRef = { path: source.sessionFile, id: source.sessionId };
        await checkedSessionReference(encodeSessionReference(sourceRef));
        requireDurableFork(await rpc.request("get_entries"), entryId);
        const result = Cancelled.parse(
          await rpc.request(entryId ? "fork" : "clone", entryId ? { entryId } : {}),
        );
        if (result.cancelled) throw new PiHistoryError("cancelledFork");
        const fork = await savedNativeReference().then(
          (reference) => ({ reference }),
          (error: unknown) => ({ error }),
        );
        // Replacement succeeded: restore even when its new file was not persisted.
        try {
          await restore(sourceRef);
        } catch (error) {
          await close("shutdown", false);
          throw error;
        }
        if ("error" in fork) throw fork.error;
        if (fork.reference === nativeId) throw new PiHistoryError("fork");
        return { nativeSessionId: fork.reference };
      } finally {
        control = false;
      }
    },
    async rollback(entryId) {
      check();
      if (!/^[-a-zA-Z0-9_]{1,128}$/.test(entryId)) throw new PiHistoryError("entry");
      control = true;
      try {
        await idle();
        await loadSessionReference(referenceDir, nativeId);
        await verifyExtension();
        const id = io.secret();
        handle.expectRollback(id);
        await rpc.request("prompt", { message: `/ace-rollback ${controlSecret} ${entryId} ${id}` });
        if (handle.rollbackResult() !== true) throw new PiHistoryError("acknowledgement");
        const state = State.parse(await rpc.request("get_state"));
        if (
          state.sessionFile !== nativeFile ||
          state.sessionId !== (await loadSessionReference(referenceDir, nativeId)).id
        ) {
          await close("shutdown", false);
          throw new PiHistoryError("identity");
        }
      } finally {
        handle.clearRollback();
        control = false;
      }
    },
    close: (reason) => close(reason),
  };
}
