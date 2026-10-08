import { nativeCommandInputs } from "@ace/commands/invocation";
import {
  loadSessionReference,
  saveSessionReference,
  sessionReferenceDirectory,
} from "./session-references.ts";
import { privateMcpConfig, AceMcpConnectionSchema } from "@ace/mcp-server";
import { fileURLToPath } from "node:url";
import type { ProviderSession, SessionContext, Frame } from "@ace/engine-api";
import type { ContentPart, InteractionResolution } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { readJsonLines } from "@ace/provider-kit/jsonl";
import { PiRpc } from "./rpc.ts";
import { runtime, type PiRuntime } from "./runtime.ts";
import { Dialog, State, Cancelled, obj, str, list, isBlockingDialogMethod } from "./native.ts";
import { piProfile } from "./capabilities.ts";
import { piInput } from "./input.ts";
import { dialogResponse } from "./dialogs.ts";
import {
  checkedSessionReference,
  encodeSessionReference,
  type SessionReference,
} from "./session-header.ts";
import { PiHistoryError } from "./history-errors.ts";
import { requireDurableFork } from "./fork-admission.ts";
export interface PiSession extends ProviderSession {
  readonly nativeSessionFile: string;
  fork(entryId?: string): Promise<{ nativeSessionId: string }>;
  rollback(entryId: string): Promise<void>;
}
export type PiOptions = {
  /** Host-owned durable reference directory, isolated by daemon data home. */
  sessionReferenceDir?: string;
  cli?: DiscoveryResult;
  executable?: string;
  runtime?: Partial<PiRuntime>;
  /** Daemon injects existing scoped lease authority; the adapter owns the returned lease. */
  openMcp?: (
    ctx: SessionContext,
    lifetime: AbortSignal,
  ) => { url: string; bearer: string; end(): void };
};
export async function openPiSession(
  ctx: SessionContext,
  options: PiOptions = {},
): Promise<PiSession> {
  ctx.signal.throwIfAborted();
  const io = { ...runtime, ...options.runtime };
  const cli =
    (ctx.executable ? undefined : options.cli) ??
    (await io.discover({
      ...((ctx.executable ?? options.executable)
        ? { executable: ctx.executable ?? options.executable }
        : {}),
      ...(ctx.env ? { env: ctx.env } : {}),
      signal: ctx.signal,
    }));
  if (!cli.path || !piProfile(cli).supported)
    throw new Error(`Pi ${cli.version ?? "unknown"} unsupported; audited version is 0.85.1`);
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
  ];
  let configuration: ReturnType<typeof privateMcpConfig>;
  try {
    configuration = privateMcpConfig(
      JSON.stringify({
        controlSecret,
        ...(lease ? { mcp: { url: lease.url, bearer: lease.bearer } } : {}),
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
    ACE_PI_SESSION_FILE: configuration.path,
    ACE_PI_CONTROL_SECRET: undefined,
    ACE_PI_MCP_URL: undefined,
    ACE_PI_MCP_BEARER: undefined,
  };
  const redact = (line: string) => {
    let out = line.replaceAll(controlSecret, "<ACE_CONTROL>");
    if (lease) out = out.replaceAll(lease.bearer, "<ACE_LEASE>");
    return out;
  };
  let proc: ReturnType<PiRuntime["spawn"]>;
  try {
    proc = io.spawn({
      command: cli.path,
      args,
      cwd: ctx.cwd,
      env,
      name: "ace-pi",
      maxLineBytes: 1024 * 1024,
    });
  } catch (error) {
    configuration.remove();
    lifetime.abort();
    lease?.end();
    throw error;
  }
  const started = io.now();
  let seq = 0,
    nativeId = "",
    nativeFile = "",
    closed = false,
    deliberate = false,
    control = false;
  let closePromise: Promise<void> | undefined;
  let rollbackAck: { id: string; success: boolean | undefined } | undefined;
  const extensionPath = fileURLToPath(new URL("./extension.ts", import.meta.url));
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
  const dialogs = new Map<string, { dialog: Dialog; cancel: () => void }>();
  const emit = (dir: Frame["dir"], payload: ProviderPayload, channel = "stdio") =>
    ctx.onFrame({
      seq: seq++,
      t: Math.max(0, Math.round(io.now() - started)),
      dir,
      channel,
      data: payload.data,
      payload,
    });
  const note = (data: unknown) =>
    emit("note", new ProviderPayload(JSON.stringify(data)), "lifecycle");
  const expire = (id: string) => {
    const d = dialogs.get(id);
    if (!d) return;
    d.cancel();
    dialogs.delete(id);
    note({ type: "dialog_expired", id });
  };
  const release = () => {
    configuration.remove();
    lifetime.abort();
    lease?.end();
    for (const d of dialogs.values()) d.cancel();
    dialogs.clear();
    ctx.signal.removeEventListener("abort", abort);
  };
  const fatal = () => {
    void close("shutdown", false);
  };
  const rpc = new PiRpc(
    proc,
    io.schedule,
    (dir, payload) => {
      emit(dir, payload);
      if (dir !== "recv") return;
      const event = obj(payload.data);
      if (event.type === "extension_ui_request" && event.method === "notify" && rollbackAck) {
        try {
          const ack = obj(JSON.parse(str(event.message)));
          if (
            ack.type === "ace_rollback" &&
            ack.id === rollbackAck.id &&
            typeof ack.success === "boolean"
          )
            rollbackAck.success = ack.success;
        } catch {
          /* Ordinary extension notification. */
        }
      }
      const p = Dialog.safeParse(payload.data);
      if (
        !p.success &&
        event.type === "extension_ui_request" &&
        isBlockingDialogMethod(event.method)
      ) {
        fatal();
        return;
      }
      if (p.success) {
        const d = p.data;
        if (dialogs.has(d.id)) return;
        if (dialogs.size >= 128) {
          fatal();
          return;
        }
        dialogs.set(d.id, {
          dialog: d,
          cancel: d.timeout === undefined ? () => {} : io.schedule(() => expire(d.id), d.timeout),
        });
      }
    },
    fatal,
    redact,
    ctx.outputFlow,
  );
  const detachStderr = readJsonLines(
    proc.stderr,
    1024 * 1024,
    (line) => emit("stderr", new ProviderPayload(JSON.stringify(redact(line)))),
    fatal,
    ctx.outputFlow,
  );
  function close(_reason: "idle" | "user" | "shutdown", expected = true): Promise<void> {
    if (closePromise) return closePromise;
    deliberate = expected;
    closed = true;
    release();
    rpc.close();
    detachStderr();
    closePromise = proc.stop({ graceMs: 1000 }).then(() => {});
    return closePromise;
  }
  function abort() {
    void close("shutdown");
  }
  ctx.signal.addEventListener("abort", abort, { once: true });
  void proc.exited.then((exit) => {
    closed = true;
    release();
    rpc.close();
    detachStderr();
    ctx.onExit({ deliberate, message: `Pi process ${exit.reason}, code ${exit.code}` });
  });
  const checkOpen = () => {
    if (closed) throw new Error("Pi session closed");
    ctx.signal.throwIfAborted();
  };
  const check = () => {
    checkOpen();
    if (control) throw new Error("Pi history operation in progress");
  };
  const idle = async () => {
    const state = State.parse(await rpc.request("get_state"));
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount || dialogs.size)
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
  try {
    note({ type: "started", processId: io.processKey() });
    await verifyExtension();
    if (resume) await restore(resume);
    const state = State.parse(await rpc.request("get_state"));
    nativeFile = state.sessionFile;
    nativeId = await saveSessionReference(referenceDir, {
      path: state.sessionFile,
      id: state.sessionId,
    });
    ctx.signal.throwIfAborted();
  } catch (error) {
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
      origin?: "ace",
    ) {
      check();
      if (origin === "ace") {
        const content = piInput(input).message;
        await rpc.request("prompt", {
          message: `/ace-context ${controlSecret} ${Buffer.from(content).toString("base64")}`,
        });
        return;
      }
      // Validate every admission before the first one can reach the harness.
      const inputs = nativeCommandInputs(input).map(piInput);
      for (const content of inputs)
        await rpc.request("prompt", {
          ...content,
          streamingBehavior: delivery === "steer" ? "steer" : "followUp",
        });
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
      checkOpen();
      const entry = dialogs.get(id);
      if (!entry) throw new Error("Pi dialog is no longer pending");
      const response = dialogResponse(entry.dialog, resolution);
      // Reserve before writing so concurrent devices cannot answer twice.
      dialogs.delete(id);
      entry.cancel();
      try {
        await rpc.write(response);
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
        rollbackAck = { id, success: undefined };
        await rpc.request("prompt", { message: `/ace-rollback ${controlSecret} ${entryId} ${id}` });
        if (rollbackAck.success !== true) throw new PiHistoryError("acknowledgement");
        const state = State.parse(await rpc.request("get_state"));
        if (
          state.sessionFile !== nativeFile ||
          state.sessionId !== (await loadSessionReference(referenceDir, nativeId)).id
        ) {
          await close("shutdown", false);
          throw new PiHistoryError("identity");
        }
      } finally {
        rollbackAck = undefined;
        control = false;
      }
    },
    close: (reason) => close(reason),
  };
}
