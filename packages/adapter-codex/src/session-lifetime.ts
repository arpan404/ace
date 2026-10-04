import { createTextRedactor } from "@ace/redaction";
import type { SupervisedProcess } from "@ace/provider-kit/process";
import type { CodexSessionContext } from "./session-context.ts";

type Retirement = "idle" | "user" | "shutdown" | "aborted" | "open_failed";
/** Process I/O and exit evidence stay outside translation and policy decision logic. */
export function sessionLifetime(config: {
  proc: SupervisedProcess;
  ctx: CodexSessionContext;
  generation: string;
  graceMs: number;
  cleanup(): void;
  emit(dir: "stderr" | "note", data: unknown): void;
}) {
  const { proc, ctx } = config;
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
  proc.stderr.on("line", (line) => {
    const safe = redact(line);
    // Scrub before slicing so neither split credentials nor raw frames enter the retained tail.
    const bytes = Buffer.from(`${stderr}${safe}\n`);
    stderr = bytes.subarray(Math.max(0, bytes.length - 4096)).toString("utf8");
    // A tail can begin inside a UTF-8 sequence; keep the encoded bound after replacement.
    while (Buffer.byteLength(stderr) > 4096) stderr = stderr.slice(1);
    config.emit("stderr", safe);
  });
  function stop(reason: Retirement): Promise<void> {
    if (closePromise) return closePromise;
    retirement = reason;
    closed = true;
    config.cleanup();
    ctx.signal.removeEventListener("abort", abort);
    closePromise = proc.stop({ graceMs: config.graceMs }).then(() => {});
    return closePromise;
  }
  const abort = () => {
    void stop("aborted");
  };
  ctx.signal.addEventListener("abort", abort, { once: true });
  void proc.exited.then((exit) => {
    closed = true;
    config.cleanup();
    ctx.signal.removeEventListener("abort", abort);
    const deliberate = retirement !== null && retirement !== "open_failed";
    const diagnostic = {
      event: "codex-session-exit",
      generation: config.generation,
      deliberate,
      retirement,
      reason: exit.reason,
      code: exit.code,
      signal: exit.signal,
      stderr,
    };
    config.emit("note", diagnostic);
    ctx.onExit({
      deliberate,
      message: `Codex app-server ${deliberate ? `retired (${retirement})` : "disconnected"}: ${JSON.stringify(diagnostic)}`,
    });
  });
  return {
    close: (reason: "idle" | "user" | "shutdown") => stop(reason),
    failOpen: () => stop("open_failed"),
    isClosed: () => closed,
  };
}
