import { discoveryFailureCode, discoveryFailureReason } from "@ace/provider-kit/discovery-failure";
import { safeCursorErrorMessage } from "./sdk-failure.ts";
import { HostRefusal } from "./host-refusal.ts";
import { Console } from "node:console";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import { z } from "zod";
import { boundedJson, RpcWriter } from "@ace/provider-kit/ipc";

const Request = z.object({
  id: z.union([z.string().max(128), z.number().int()]),
  method: z.string().max(128),
  params: z.unknown().optional(),
});
const Reply = z.object({
  id: z.string(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const ReplyError = z.object({ message: z.string() });
/** ace's own words for why it did not store a frame, bounded; this is the turn's fence notice. */
function refusal(error: unknown): string {
  const reply = ReplyError.safeParse(error);
  return reply.success ? reply.data.message.slice(0, 512) : "ace refused a Cursor SDK frame";
}
const consoleMethods = [
  "log",
  "error",
  "warn",
  "info",
  "debug",
  "dir",
  "dirxml",
  "table",
  "trace",
  "group",
  "groupCollapsed",
  "groupEnd",
  "count",
  "countReset",
  "time",
  "timeEnd",
  "timeLog",
  "assert",
] as const;
/**
 * Stdout is the JSON-RPC channel, and stderr is patched to redact and bound each line. Bun's
 * console writes to fds 1 and 2 directly, past both patches, so every console method is sent
 * through the patched stderr instead.
 */
function routeConsoleToStderr() {
  const sink = new Console({ stdout: process.stderr, stderr: process.stderr });
  for (const method of consoleMethods)
    Object.assign(console, { [method]: sink[method].bind(sink) });
}
/** All writes await the shared bounded pipe writer, including onDelta callbacks. */
export function hostWire(
  dispatch: (method: string, params: unknown) => Promise<unknown>,
  disconnected: () => void,
  maxFrameBytes = 1_048_576,
) {
  const stdout = process.stdout.write.bind(process.stdout);
  // SDK logs are not the replay boundary and may contain login diagnostics.
  process.stdout.write = () => true;
  const stderr = process.stderr.write.bind(process.stderr);
  const decoder = new StringDecoder("utf8");
  let pendingStderr = "",
    oversizedStderr = false;
  const flushStderr = () => {
    if (pendingStderr || oversizedStderr)
      stderr(
        oversizedStderr
          ? "SDK stderr exceeded its safe line budget\n"
          : safeCursorErrorMessage(pendingStderr, { CURSOR_API_KEY: process.env.CURSOR_API_KEY }) +
              "\n",
      );
    pendingStderr = "";
    oversizedStderr = false;
  };
  process.on("exit", flushStderr);
  routeConsoleToStderr();
  process.stderr.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline;
      if (!oversizedStderr) {
        if (pendingStderr.length + end - start > 65536) {
          pendingStderr = "";
          oversizedStderr = true;
        } else pendingStderr += text.slice(start, end);
      }
      if (newline === -1) break;
      flushStderr();
      start = newline + 1;
    }
    const done = typeof encoding === "function" ? encoding : callback;
    if (done) queueMicrotask(() => done());
    return true;
  };
  const output = new Transform({
    transform(chunk, _encoding, callback) {
      stdout(chunk, callback);
    },
  });
  const writer = new RpcWriter(output, 2_097_152);
  const send = async (message: unknown) => {
    const line = boundedJson(message, maxFrameBytes - 1) + "\n";
    await writer.send(line, Buffer.byteLength(line));
  };
  let outbound = 0;
  const acknowledgements = new Map<
    string,
    { resolve(): void; reject(reason: string): void; timer: ReturnType<typeof setTimeout> }
  >();
  const confirmed = async (method: string, params: unknown, timeoutMs = 300_000) => {
    if (acknowledgements.size >= 32) throw new Error("SDK storage acknowledgements exceed budget");
    const id = `host:${++outbound}`;
    const completion = Promise.withResolvers<void>();
    void completion.promise.catch(() => {});
    const timer = setTimeout(() => {
      acknowledgements.delete(id);
      completion.reject(
        new Error("ace took too long to store a Cursor SDK frame (acknowledgement expired)"),
      );
    }, timeoutMs);
    acknowledgements.set(id, {
      resolve: () => completion.resolve(),
      reject: (reason) => completion.reject(new Error(reason)),
      timer,
    });
    try {
      await send({ jsonrpc: "2.0", id, method, params });
      await completion.promise;
    } finally {
      clearTimeout(timer);
      acknowledgements.delete(id);
    }
  };
  let lineBytes = 0;
  const input = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        lineBytes = byte === 10 ? 0 : lineBytes + 1;
        if (lineBytes > maxFrameBytes) return callback(new Error("Host input overflow"));
      }
      callback(null, chunk);
    },
  });
  process.stdin.pipe(input);
  let pending = 0;
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const decoded: unknown = JSON.parse(line);
    const reply = Reply.safeParse(decoded);
    if (reply.success && reply.data.id.startsWith("host:")) {
      // A reply after the host stopped waiting finds nothing: that frame already fenced its
      // turn, and a late answer from a busy daemon is no reason to stop the host.
      const acknowledgement = acknowledgements.get(reply.data.id);
      if (!acknowledgement) return;
      if (reply.data.error !== undefined) acknowledgement.reject(refusal(reply.data.error));
      else acknowledgement.resolve();
      return;
    }
    if (++pending > 16) {
      disconnected();
      return;
    }
    void (async () => {
      let id: string | number | undefined;
      let method: string | undefined;
      try {
        const request = Request.parse(decoded);
        id = request.id;
        method = request.method;
        const result = await dispatch(request.method, request.params);
        await send({ jsonrpc: "2.0", id, result: result ?? null });
      } catch (error) {
        // Never pass vendor exception text, stacks, request headers or auth returns.
        if (id !== undefined)
          await send({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: "Cursor SDK operation failed; check safe lifecycle notice",
              data: {
                code: discoveryFailureCode(error),
                // The SDK never saw this request, so the caller may report it as not taken.
                ...(error instanceof HostRefusal ? { refused: true } : {}),
                ...(method === "models" && discoveryFailureCode(error) === "discovery_failed"
                  ? {
                      detail: discoveryFailureReason(error, {
                        env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY },
                      }),
                    }
                  : {}),
              },
            },
          });
        else disconnected();
      } finally {
        pending--;
      }
    })().catch(disconnected);
  });
  input.on("error", disconnected);
  process.stdin.on("end", disconnected);
  return {
    confirmed,
    notify: (method: string, params: unknown) => send({ jsonrpc: "2.0", method, params }),
  };
}
