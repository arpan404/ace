// SPDX-License-Identifier: Apache-2.0
/**
 * The native Cursor facade behind `ACE_SESSIONS=cursor` (E3-cursor.3). It is `openCursorSession`
 * with the daemon half replaced: the Rust session frames, answers the host's acknowledgements,
 * steers, keeps the turn's state and closes, through the shared bridge (E3.0c). This file keeps
 * the open's composition, the spawn, `CursorHost`'s diagnostic fields, the stop plan and the
 * engine-facing surface.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  InputRejected,
  SteerTargetLost,
  assertSteerTarget,
  type ProviderSession,
  type SessionContext,
} from "@ace/engine-api";
import { discoveryFailureCode, discoveryFailureReason } from "@ace/provider-kit/discovery-failure";
import { readCursorModelParams } from "@ace/provider-kit/cursor-selection";
import {
  sessionBridge,
  type BridgeHooks,
  type NativeSessionPort,
} from "@ace/provider-kit/native-session-bridge";
import { sessionsAddonPath } from "@ace/provider-kit/native-switches";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { Limits } from "./contracts.ts";
import { fatalDetail, isNoiseLine } from "./host-fatal.ts";
import { refusedByHost } from "./host-refusal.ts";
import { cursorCapabilitiesForSandbox } from "./policy.ts";
import { safeCursorErrorMessage } from "./sdk-failure.ts";
import type { CursorSessionOptions } from "./session.ts";

/** The handle the addon's `CursorSessionNative` exposes. */
export interface NativeCursorHandle extends NativeSessionPort {
  outputTarget(): NonNullable<Parameters<typeof spawnSupervised>[0]["nativeOutput"]>;
  open(id: number, openJson: string, snapshotJson?: string): void;
  configure(id: number, model: string, modelParamsJson?: string): void;
  send(sendJson: string, id: number, steerLost: boolean): void;
  interrupt(id: number, agent: string | undefined, cascade: boolean): void;
  close(id: number, reason: string): void;
  exit(
    code: number | null | undefined,
    signal: string | null | undefined,
    reason: string,
    detail?: string,
    stopCause?: string,
  ): void;
  note(name: string, text?: string): void;
  committed(seq: number): void;
  refused(seq: number, reason: string): void;
  written(ticket: number): void;
  timer(key: string): void;
  undrain(): void;
  abandon(): void;
}

export interface NativeSessionsAddon {
  CursorSessionNative: new (
    configJson: string,
    events: (error: unknown, batch: string) => void,
  ) => NativeCursorHandle;
}

let loaded: NativeSessionsAddon | undefined;

/** The sessions addon, loaded once; absent, the open fails rather than running TypeScript. */
function addon(): NativeSessionsAddon {
  if (loaded) return loaded;
  const path = sessionsAddonPath();
  if (!existsSync(path)) throw new Error(`ACE_SESSIONS=cursor needs the sessions addon at ${path}`);
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module, path);
  loaded = module.exports as unknown as NativeSessionsAddon;
  return loaded;
}

/** What `requestFailure` needs from the session's diagnostics (`host.ts:207`-`:244`). */
export interface RequestFailureState {
  errorMessage?: string | undefined;
  metadataFailureCode?: DiscoveryFailureCode | undefined;
  metadataFailureDetail?: string | undefined;
  /** The process's exit, read only once its signal aborted (`host.ts:213`). */
  exit?: { code: number | null | undefined; reason: string } | undefined;
}

/**
 * `CursorHost.request`'s catch (`host.ts:215`-`:241`), unchanged: the discovery code the error
 * carries or the metadata's, the "ended with code ..." reason for a closed pipe, and the
 * `refused` mark `refusedByHost` reads. The facade calls it only for a settlement that is not
 * already the bridge's `InputRejected` or `SteerTargetLost`.
 */
export function requestFailure(method: string, error: unknown, state: RequestFailureState): Error {
  const code = discoveryFailureCode(
    error,
    state.metadataFailureCode ??
      (state.exit?.reason === "spawn-error" || state.exit?.code === 78
        ? "not_configured"
        : "discovery_failed"),
  );
  const suppliedReason = discoveryFailureReason(error);
  const reason = /^(?:process (?:exited|closed)|JSON-RPC closed|closed|EOF|write EPIPE)$/i.test(
    suppliedReason,
  )
    ? `Cursor SDK host ended with code ${state.exit?.code ?? "none"} (${state.exit?.reason ?? "request rejected"}). ${state.metadataFailureDetail ?? suppliedReason}`.slice(
        0,
        2048,
      )
    : suppliedReason;
  return Object.assign(
    new Error(
      `${["open", "send", "cancel"].includes(method) && state.errorMessage ? state.errorMessage + " " : ""}Cursor SDK ${method} failed; delivery may be uncertain. Inspect history before resending.`,
    ),
    {
      code,
      ...(method === "models" && code === "discovery_failed" ? { detail: reason } : {}),
      ...(refusedByHost(error) ? { refused: true } : {}),
    },
  );
}

/** A refusal the binding threw: its message is the code and text as JSON (`session_cursor.rs`). */
function refusal(error: unknown): Error | undefined {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { code?: unknown; message?: unknown };
    if (typeof parsed.code !== "string" || typeof parsed.message !== "string") return undefined;
    const Type = parsed.code === "ACE_STEER_TARGET_LOST" ? SteerTargetLost : InputRejected;
    if (parsed.code !== "ACE_STEER_TARGET_LOST" && parsed.code !== "ACE_INPUT_REJECTED")
      return undefined;
    return new Type(parsed.message, { cause: error });
  } catch {
    return undefined;
  }
}

export async function openNativeCursorSession(
  context: SessionContext,
  options: CursorSessionOptions,
): Promise<ProviderSession> {
  context.signal.throwIfAborted();
  if (context.resume && context.resume.backend !== "cursor-sdk")
    throw new Error("Cursor SDK cannot resume an ACP checkpoint; use explicit context handoff");
  if (context.resume && context.resume.instanceId !== options.instanceId)
    throw new Error("SDK resume is pinned to its original provider instance");
  const limits = Limits.parse(options.limits ?? {});
  const native = addon();
  const redaction = {
    ...options.env,
    ...(options.mcp ? { ACE_MCP_BEARER: options.mcp.bearer } : {}),
  };
  const started = (options.now ?? Date.now)();
  let nextId = 0;
  // `CursorHost`'s diagnostic fields, kept here now that host prose is a port (`host.ts:71`-`:76`).
  let errorMessage: string | undefined;
  let fatalMessage: string | undefined;
  let stopReason: string | undefined;
  let metadataFailureDetail: string | undefined;
  let metadataFailureCode: DiscoveryFailureCode | undefined;
  const stopCause = () => fatalMessage ?? stopReason;
  const failureMessage = () => stopCause() ?? errorMessage;

  let proc: SupervisedProcess | undefined;
  let bridge: ReturnType<typeof sessionBridge>;
  let handle: NativeCursorHandle;

  /** The host's stderr prose, as `host.ts:191`-`:206` reads it. */
  const stderrLine = (line: string) => {
    const fatal = fatalDetail(line);
    if (fatal) fatalMessage ??= safeCursorErrorMessage(fatal, redaction);
    else if (!isNoiseLine(line)) errorMessage = safeCursorErrorMessage(line, redaction);
    const code = discoveryFailureCode({ message: line });
    if (code !== "discovery_failed") metadataFailureCode = code;
    if (
      line.trim() &&
      !/^(?:\s*at\s|node:internal\/|Node\.js\sv)/.test(line) &&
      (!metadataFailureDetail || code !== "discovery_failed" || /\b[A-Za-z]*Error[:[]/.test(line))
    )
      metadataFailureDetail = discoveryFailureReason({ message: line }, { env: redaction });
  };

  const hooksCtx = {
    ...context,
    onFrame: (frame: Parameters<NonNullable<SessionContext["onFrame"]>>[0]) => wrapper(frame),
  };
  handle = new native.CursorSessionNative(
    JSON.stringify({
      generation: randomUUID(),
      instanceId: options.instanceId,
      rootKey: context.rootKey ?? "root",
      limits,
      capabilities: JSON.stringify(cursorCapabilitiesForSandbox(true)),
    }),
    (_error: unknown, batch: string) => bridge.deliver(batch),
  );

  /** `onFrame`, wrapped: the commit's outcome crosses back as a number, never a rejection. */
  const wrapper = async (frame: Parameters<NonNullable<SessionContext["onFrame"]>>[0]) => {
    try {
      await context.onFrame(frame);
      handle.committed(frame.seq);
    } catch (error) {
      handle.refused(
        frame.seq,
        `ace could not store a Cursor SDK frame: ${safeCursorErrorMessage(error, redaction)}`,
      );
    }
  };

  const stopChild = async () => {
    if (!proc) return;
    try {
      if (process.platform === "win32") {
        const { stopTreeAfterEof } = await import("@ace/provider-kit/tree-stop");
        await stopTreeAfterEof(proc, limits.graceMs);
      } else {
        await proc.stop({ graceMs: limits.graceMs });
      }
    } finally {
      handle.note("stop");
    }
  };

  const hooks: BridgeHooks = {
    now: () => (options.now ?? Date.now)(),
    started,
    schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    timer: (key) => handle.timer(key),
    fatal: (message) => {
      stopReason ??= message;
      void stopChild().catch(() => {});
    },
    drained: () => {},
    port: (name, json) => {
      const payload = safeParse(json);
      if (name === "stderr") stderrLine(String(payload["line"] ?? ""));
      else if (name === "stray")
        handle.note(
          "host-output",
          safeCursorErrorMessage(String(payload["line"] ?? ""), redaction),
        );
      else if (name === "connection")
        fail(
          `Cursor SDK host connection failed: ${safeCursorErrorMessage(String(payload["message"] ?? ""), redaction)}`,
        );
      else if (name === "errorFrame")
        errorMessage = safeCursorErrorMessage(String(payload["message"] ?? ""), redaction);
      else if (name === "stop") {
        const reason = payload["reason"];
        if (typeof reason === "string") fail(reason);
        else void stopChild().catch(() => {});
      } else if (name === "exited") void reportExit();
    },
  };
  bridge = sessionBridge(hooksCtx, handle, hooks, {
    ACE_CURSOR_RPC: Error,
    ACE_INPUT_REJECTED: InputRejected,
    ACE_STEER_TARGET_LOST: SteerTargetLost,
  });

  const fail = (reason: string) => {
    stopReason ??= reason;
    void stopChild().catch(() => {});
  };

  const reportExit = async () => {
    if (!proc) return;
    const exit = await proc.exited;
    handle.exit(exit.code ?? null, exit.signal ?? null, exit.reason, failureMessage(), stopCause());
  };

  try {
    proc = (options.spawn ?? spawnSupervised)({
      command: options.node ?? process.execPath,
      args: [
        `--max-old-space-size=${limits.heapMb}`,
        options.entry ?? fileURLToPath(new URL("./host-entry.ts", import.meta.url)),
        String(limits.graceMs),
      ],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...options.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
      name: "cursor-sdk-host",
      ...(context.outputFlow ? { outputFlow: context.outputFlow } : {}),
      maxLineBytes: limits.maxFrameBytes,
      onStderrLineDropped: () => {},
      nativeOutput: handle.outputTarget(),
    });
  } catch (error) {
    handle.abandon();
    throw error;
  }
  void proc.exited.then(() => undefined).catch(() => undefined);

  /** One command's settlement, mapped as `CursorHost.request`'s catch maps it. */
  const request = (id: number, method: string): Promise<unknown> =>
    bridge.expect(id).catch(async (error: unknown) => {
      if (error instanceof InputRejected || error instanceof SteerTargetLost) throw error;
      const exit = proc?.signal.aborted ? await proc.exited : undefined;
      throw requestFailure(method, error, {
        errorMessage,
        metadataFailureCode,
        metadataFailureDetail,
        exit: exit === undefined ? undefined : { code: exit.code ?? null, reason: exit.reason },
      });
    });
  const openId = ++nextId;
  handle.open(
    openId,
    JSON.stringify({
      cwd: context.cwd,
      threadId: context.threadId,
      ...(context.storeGeneration ? { checkpointGeneration: context.storeGeneration } : {}),
      ...(context.model ? { model: context.model } : {}),
      modelParams: readCursorModelParams(context.options),
      ...(context.resume
        ? {
            nativeSessionId: context.resume.nativeSessionId,
            ...(context.resume.unsettled ? { recover: context.resume.unsettled } : {}),
          }
        : {}),
      ...(context.permissionMode ? { permissionMode: context.permissionMode } : {}),
      autoReviewAvailable: options.autoReviewAvailable ?? false,
      ...(options.mcp ? { mcp: { url: options.mcp.url, bearer: options.mcp.bearer } } : {}),
      ...(options.mcp && options.instructions ? { instructions: options.instructions } : {}),
    }),
    options.recoverySnapshot ? JSON.stringify(options.recoverySnapshot) : undefined,
  );
  const reply = (await request(openId, "open")) as { nativeSessionId: string };

  let closing: Promise<void> | undefined;
  const close = (reason: "idle" | "user" | "shutdown"): Promise<void> => {
    closing ??= (async () => {
      const id = ++nextId;
      handle.close(id, reason);
      await request(id, "close");
    })();
    return closing;
  };
  const abort = () => {
    void close("shutdown").catch(() => {});
  };
  context.signal.addEventListener("abort", abort, { once: true });

  return {
    nativeSessionId: reply.nativeSessionId,
    backend: "cursor-sdk",
    instanceId: options.instanceId,
    async configure(selection) {
      if (selection.provider !== "cursor" || !selection.model)
        throw new Error("Invalid Cursor selection");
      const id = ++nextId;
      const params = readCursorModelParams(selection.options);
      handle.configure(
        id,
        selection.model,
        params === undefined ? undefined : JSON.stringify(params),
      );
      await request(id);
    },
    async send(input, delivery, commandId, _origin, fence) {
      let steerLost = false;
      let kept: unknown;
      try {
        assertSteerTarget(delivery, fence);
      } catch (error) {
        steerLost = true;
        kept = error;
      }
      const id = ++nextId;
      try {
        handle.send(
          JSON.stringify({
            input,
            delivery,
            ...(commandId ? { commandId } : {}),
            ...(options.operationId ? { operationId: options.operationId() } : {}),
          }),
          id,
          steerLost,
        );
      } catch (error) {
        throw refusal(error) ?? error;
      }
      try {
        await request(id, "send");
      } catch (error) {
        if (steerLost && kept !== undefined) throw kept;
        throw error;
      }
    },
    async interrupt(target) {
      if (target.agent !== undefined && target.agent !== (context.rootKey ?? "root"))
        throw new Error("unsupported: Cursor SDK task children are read-only");
      const id = ++nextId;
      try {
        handle.interrupt(
          id,
          target.agent === undefined ? undefined : String(target.agent),
          target.cascade,
        );
      } catch (error) {
        throw refusal(error) ?? error;
      }
      await request(id, "cancel");
    },
    resolve() {
      return Promise.reject(
        new Error(
          "unsupported: Cursor SDK has sandbox-only approvals and no question or plan-review callback",
        ),
      );
    },
    stopTask() {
      return Promise.reject(
        new Error("unsupported: Cursor SDK individual task control is unavailable"),
      );
    },
    close,
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
