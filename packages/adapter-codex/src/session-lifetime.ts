import { CodexExitDiagnostic } from "./exit-diagnostic.ts";
import { createTextRedactor } from "@ace/redaction";
import type { CodexChannel, HostExit, Retirement } from "./host.ts";
import type { CodexSessionContext } from "./session-context.ts";

/** Channel and exit evidence stay outside translation and policy decision logic. */
export function sessionLifetime(config: {
  ctx: CodexSessionContext;
  generation: string;
  /** Refuse new commands; internal stop requests still flow. */
  closing(): void;
  /** Release session state once nothing more will be sent. */
  cleanup(): void;
  /** Live turns or shells anywhere in this session's tree. */
  busy(): boolean;
  /** Stop every turn and shell in the tree. Throws when that cannot be confirmed. */
  stopWork(): Promise<void>;
  emit(dir: "stderr" | "note", data: unknown): void;
}) {
  const { ctx } = config;
  const redact = createTextRedactor({
    workspace: ctx.cwd,
    env: {
      ...process.env,
      ...ctx.env,
      ...(ctx.aceMcp ? { ACE_MCP_BEARER_TOKEN: ctx.aceMcp.bearer } : {}),
    },
  });
  let stderr = "";
  let retirement: Retirement | null = null;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  let exited = false;
  let cleaned = false;
  let channel: CodexChannel | undefined;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    config.cleanup();
  };
  function stop(reason: Retirement): Promise<void> {
    if (closePromise) return closePromise;
    // Retiring after the process died only finishes cleanup; it cannot make the loss deliberate.
    if (!exited && !channel?.gone) retirement = reason;
    closed = true;
    config.closing();
    ctx.signal.removeEventListener("abort", abort);
    const error =
      reason === "aborted" && ctx.signal.aborted
        ? ctx.signal.reason instanceof Error
          ? ctx.signal.reason
          : new Error(String(ctx.signal.reason))
        : new Error(`Codex session closed (${reason})`);
    closePromise = (async () => {
      if (!channel || exited) {
        cleanup();
        return;
      }
      // Busy and alone: stopping the process ends the work exactly, as a private process does.
      if (channel.shared && channel.alone && config.busy()) {
        cleanup();
        await channel.retire();
        return;
      }
      // A shared process keeps running: this tree's work must stop before ace lets go of it.
      if (channel.shared && config.busy())
        try {
          await config.stopWork();
        } catch {
          // Unconfirmed work cannot be left running unobserved. Stop the process instead.
          cleanup();
          await channel.retire();
          return;
        }
      cleanup();
      await channel.detach(reason, error);
    })();
    return closePromise;
  }
  const abort = () => {
    void stop("aborted");
  };
  ctx.signal.addEventListener("abort", abort, { once: true });
  return {
    attached(value: CodexChannel): void {
      channel = value;
    },
    stderr(line: string): void {
      const safe = redact(line);
      // Scrub before slicing so neither split credentials nor raw frames enter the retained tail.
      const bytes = Buffer.from(`${stderr}${safe}\n`);
      stderr = bytes.subarray(Math.max(0, bytes.length - 4096)).toString("utf8");
      // A tail can begin inside a UTF-8 sequence; keep the encoded bound after replacement.
      while (Buffer.byteLength(stderr) > 4096) stderr = stderr.slice(1);
      config.emit("stderr", safe);
    },
    exited(exit: HostExit): void {
      exited = true;
      closed = true;
      config.closing();
      cleanup();
      ctx.signal.removeEventListener("abort", abort);
      const deliberate =
        retirement !== null && retirement !== "open_failed" && retirement !== "rpc_failed";
      const diagnostic = CodexExitDiagnostic.parse({
        event: "codex-session-exit",
        generation: config.generation,
        deliberate,
        retirement,
        reason: exit.reason,
        code: exit.code,
        signal: exit.signal,
        stderr,
        stderrSummary: stderr.slice(-1024),
        outputDrained: exit.outputDrained,
        ...(exit.pid !== undefined ? { pid: exit.pid } : {}),
      });
      config.emit("note", diagnostic);
      ctx.onExit({
        deliberate,
        message: `Codex app-server ${deliberate ? `retired (${retirement})` : "disconnected"}: ${JSON.stringify(diagnostic)}`,
      });
    },
    close: (reason: "idle" | "user" | "shutdown") => stop(reason),
    failOpen: () => stop("open_failed"),
    failTransport: () => stop("rpc_failed"),
    isClosed: () => closed,
  };
}
