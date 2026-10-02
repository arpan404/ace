import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

/** SDK transport bridge; provider-kit owns the process group and all shutdowns. */
export function spawnSdkProcess(
  options: SpawnOptions,
  hooks: {
    onStderr(line: string): void;
    onWire(dir: "send" | "recv", data: unknown): void;
    onProcess(process: SupervisedProcess): void;
  },
): SpawnedProcess {
  const process = spawnSupervised({
    command: options.command,
    args: options.args,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    name: "claude",
  });
  const stdout = new PassThrough();
  const events = new EventEmitter();
  let killed = false;
  let exitCode: number | null = null;
  process.stdout.on("line", (line) => {
    // SDK consumes controls internally. Forward cancellations and unknown wire data too.
    try {
      const data: unknown = JSON.parse(line);
      if (
        typeof data === "object" &&
        data !== null &&
        "type" in data &&
        (String(data.type).startsWith("control_") ||
          ![
            "system",
            "assistant",
            "user",
            "result",
            "stream_event",
            "rate_limit_event",
            "keep_alive",
            "tool_progress",
            "tool_use_summary",
            "auth_status",
            "prompt_suggestion",
          ].includes(String(data.type)))
      )
        hooks.onWire("recv", data);
    } catch {
      hooks.onWire("recv", { type: "malformed_stdout", line });
    }
    stdout.write(`${line}\n`);
  });
  process.stderr.on("line", hooks.onStderr);
  let outbound = "";
  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      outbound += String(chunk);
      let newline: number;
      while ((newline = outbound.indexOf("\n")) >= 0) {
        const line = outbound.slice(0, newline);
        outbound = outbound.slice(newline + 1);
        try {
          const data: unknown = JSON.parse(line);
          if (typeof data === "object" && data !== null && "type" in data && data.type !== "user")
            hooks.onWire("send", data);
        } catch {
          hooks.onWire("send", { type: "malformed_stdin", line });
        }
      }
      process.stdin.write(chunk, callback);
    },
    final(callback) {
      process.stdin.end(callback);
    },
  });
  // The SDK observes process exit; write errors also reach its write callback.
  stdin.on("error", () => {});
  const abort = () => {
    killed = true;
    void process.stop();
  };
  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });
  void process.exited.then((exit) => {
    options.signal.removeEventListener("abort", abort);
    exitCode = exit.code;
    stdout.end();
    if (exit.reason === "spawn-error")
      events.emit("error", new Error("Claude process failed to spawn"));
    events.emit("exit", exit.code, exit.signal);
  });
  hooks.onProcess(process);
  return {
    stdin,
    stdout,
    get killed() {
      return killed;
    },
    get exitCode() {
      return exitCode;
    },
    kill(signal) {
      killed = true;
      void process.stop({ graceMs: signal === "SIGKILL" ? 0 : 5_000 });
      return true;
    },
    on(event, listener) {
      events.on(event, listener);
    },
    once(event, listener) {
      events.once(event, listener);
    },
    off(event, listener) {
      events.off(event, listener);
    },
  };
}
