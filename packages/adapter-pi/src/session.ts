import { fileURLToPath } from "node:url";
import type { ProviderSession, SessionContext, Frame } from "@ace/engine-api";
import type { ContentPart, InteractionResolution } from "@ace/protocol";
import { PiPermissionMode } from "@ace/protocol/pi";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { readJsonLines } from "@ace/provider-kit/jsonl";
import { PiRpc } from "./rpc.ts";
import { runtime, type PiRuntime } from "./runtime.ts";
import { Dialog, State, Cancelled, obj, str, list } from "./native.ts";
import { piPermissionArgs, piProfile } from "./capabilities.ts";
import { piInput } from "./input.ts";
import { dialogResponse } from "./dialogs.ts";
export interface PiSession extends ProviderSession {
  fork(entryId?: string): Promise<{ nativeSessionId: string }>;
  rollback(entryId: string): Promise<void>;
}
export type PiOptions = {
  cli?: DiscoveryResult;
  executable?: string;
  permissionMode?: PiPermissionMode;
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
    options.cli ??
    (await io.discover({
      ...(options.executable ? { executable: options.executable } : {}),
      ...(ctx.env ? { env: ctx.env } : {}),
      signal: ctx.signal,
    }));
  if (!cli.path || !piProfile(cli).supported)
    throw new Error(`Pi ${cli.version ?? "unknown"} unsupported; audited version is 0.85.1`);
  const mode = options.permissionMode ?? "unrestricted",
    permissionArgs = piPermissionArgs(mode);
  const lifetime = new AbortController();
  const controlSecret = io.secret();
  const lease = mode === "unrestricted" ? options.openMcp?.(ctx, lifetime.signal) : undefined;
  const args = [
    "--mode",
    "rpc",
    ...permissionArgs,
    "-e",
    fileURLToPath(new URL("./extension.ts", import.meta.url)),
    ...(ctx.model ? ["--model", ctx.model] : []),
  ];
  const env = {
    ...ctx.env,
    ACE_PI_CONTROL_SECRET: controlSecret,
    ACE_PI_MCP_URL: lease?.url ?? "",
    ACE_PI_MCP_BEARER: lease?.bearer ?? "",
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
    lifetime.abort();
    lease?.end();
    throw error;
  }
  const started = io.now();
  let seq = 0,
    nativeId = "",
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
  );
  const detachStderr = readJsonLines(
    proc.stderr,
    1024 * 1024,
    (line) => emit("stderr", new ProviderPayload(JSON.stringify(redact(line)))),
    fatal,
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
  const check = () => {
    if (closed) throw new Error("Pi session closed");
    if (control) throw new Error("Pi history operation in progress");
    ctx.signal.throwIfAborted();
  };
  const idle = async () => {
    const state = State.parse(await rpc.request("get_state"));
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount || dialogs.size)
      throw new Error("Pi history controls require an idle session");
    return state;
  };
  async function restore(path: string): Promise<void> {
    const result = Cancelled.parse(await rpc.request("switch_session", { sessionPath: path }));
    if (result.cancelled) throw new Error("Pi extension cancelled session switch");
    const state = State.parse(await rpc.request("get_state"));
    if (state.sessionFile !== path) throw new Error("Pi restored a different session");
  }
  try {
    note({ type: "started", processId: io.processKey() });
    await verifyExtension();
    if (ctx.resume) await restore(ctx.resume.nativeSessionId);
    nativeId = State.parse(await rpc.request("get_state")).sessionFile;
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
    async send(input: ContentPart[], delivery: "steer" | "queue") {
      check();
      await rpc.request("prompt", {
        ...piInput(input),
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
      check();
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
        const result = Cancelled.parse(
          await rpc.request(entryId ? "fork" : "clone", entryId ? { entryId } : {}),
        );
        if (result.cancelled) throw new Error("Pi extension cancelled fork");
        let fork: string;
        try {
          fork = State.parse(await rpc.request("get_state")).sessionFile;
        } catch (error) {
          await close("shutdown", false);
          throw error;
        }
        try {
          await restore(source.sessionFile);
        } catch (error) {
          await close("shutdown", false);
          throw error;
        }
        if (fork === source.sessionFile) throw new Error("Pi fork did not create a new session");
        return { nativeSessionId: fork };
      } finally {
        control = false;
      }
    },
    async rollback(entryId) {
      check();
      if (!/^[-a-zA-Z0-9_]{1,128}$/.test(entryId)) throw new Error("Invalid Pi entry id");
      control = true;
      try {
        await idle();
        await verifyExtension();
        const id = io.secret();
        rollbackAck = { id, success: undefined };
        await rpc.request("prompt", { message: `/ace-rollback ${controlSecret} ${entryId} ${id}` });
        if (rollbackAck.success !== true) throw new Error("Pi navigation was not acknowledged");
        const state = State.parse(await rpc.request("get_state"));
        if (state.sessionFile !== nativeId) {
          await close("shutdown", false);
          throw new Error("Pi navigation changed the session identity");
        }
      } finally {
        rollbackAck = undefined;
        control = false;
      }
    },
    close: (reason) => close(reason),
  };
}
