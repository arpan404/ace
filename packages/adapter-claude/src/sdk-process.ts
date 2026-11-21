import { privateMcpConfig } from "@ace/mcp-server";
import { droppedLineNotes } from "@ace/provider-kit/dropped-line-notes";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { object } from "./native.ts";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

function unrefSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/** SDK transport bridge; provider-kit owns the process group and all shutdowns. */
export function spawnSdkProcess(
  options: SpawnOptions,
  hooks: {
    onStderr(line: string): void;
    onWire(dir: "send" | "recv", data: unknown): void;
    onProcess(process: SupervisedProcess): void;
    spawn?: typeof spawnSupervised;
    maxOutputBytes?: number;
    outputFlow?: import("@ace/provider-kit/flow-control").OutputFlow;
    lease?: import("@ace/provider-kit/process").ProcessLease;
    /** Times the dropped-stderr summaries; defaults to an unref'd timer. */
    schedule?: (run: () => void, ms: number) => () => void;
  },
): SpawnedProcess {
  const args = [...options.args];
  const configIndex = args.indexOf("--mcp-config") + 1;
  const encoded = configIndex > 0 ? args[configIndex] : undefined;
  const file = encoded?.startsWith("{") ? privateMcpConfig(encoded, options.cwd) : undefined;
  if (file) args[configIndex] = file.path;
  // At most one note a second, however much stderr Claude floods.
  const stderrDrops = droppedLineNotes({
    note: (text) => hooks.onStderr(text),
    schedule: hooks.schedule ?? unrefSchedule,
  });
  let process: SupervisedProcess;
  try {
    process = (hooks.spawn ?? spawnSupervised)({
      command: options.command,
      args,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      name: "claude",
      ...(hooks.lease ? { lease: hooks.lease } : {}),
      ...(hooks.outputFlow ? { outputFlow: hooks.outputFlow } : {}),
      maxLineBytes: 16 * 1024 * 1024,
      // MCP servers' logs pass through stderr; a long one is noted, never fatal to the turn.
      onStderrLineDropped: (line) => stderrDrops.dropped(line),
      ...(hooks.maxOutputBytes === undefined ? {} : { maxOutputBytes: hooks.maxOutputBytes }),
    });
  } catch (error) {
    file?.remove();
    throw error;
  }
  const stdout = new PassThrough();
  const events = new EventEmitter();
  let killed = false;
  let exitCode: number | null = null;
  process.stdout.on("line", (line) => {
    // SDK consumes controls internally. Forward cancellations and unknown wire data too.
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      hooks.onWire("recv", { type: "malformed_stdout", line });
      return;
    }
    const type = object(data)["type"];
    if (typeof type !== "string") {
      hooks.onWire("recv", data);
      return;
    }
    if (
      type.startsWith("control_") ||
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
      ].includes(type)
    )
      hooks.onWire("recv", data);
    // Exit can resolve while lines still wait behind backpressure; the SDK's stream has ended
    // by then. Writing would raise an error event nobody hears, so the line is kept as wire data.
    if (stdout.writableEnded) {
      hooks.onWire("recv", { type: "late_stdout", line });
      return;
    }
    if (!stdout.write(`${line}\n`)) process.stdout.pause();
  });
  stdout.on("error", () => {});
  stdout.on("drain", () => process.stdout.resume());
  process.stderr.on("line", hooks.onStderr);
  let outbound = "";
  const stdin = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      outbound += String(chunk);
      if (Buffer.byteLength(outbound) > 16 * 1024 * 1024) {
        callback(new Error("Claude outbound frame capacity reached"));
        outbound = "";
        // The write callback reports this failure; a surviving tree warns inside stop().
        void process.stop({ graceMs: 0 }).catch(() => {});
        return;
      }
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
    // A surviving tree warns inside stop().
    void process.stop().catch(() => {});
  };
  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });
  // The SDK observes this exit too, so the chain has no other listener to report to.
  void process.exited
    .then((exit) => {
      stderrDrops.flush();
      file?.remove();
      options.signal.removeEventListener("abort", abort);
      exitCode = exit.code;
      stdout.end();
      if (exit.reason === "spawn-error")
        events.emit("error", new Error("Claude process failed to spawn"));
      events.emit("exit", exit.code, exit.signal);
    })
    .catch(() => {});
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
      // A surviving tree warns inside stop().
      void process.stop({ graceMs: signal === "SIGKILL" ? 0 : 5_000 }).catch(() => {});
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
