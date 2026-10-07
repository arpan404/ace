import { discoveryFailureCode } from "@ace/provider-kit/discovery-failure";
import { safeCursorErrorMessage } from "./sdk-failure.ts";
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
    { resolve(): void; reject(): void; timer: ReturnType<typeof setTimeout> }
  >();
  const confirmed = async (method: string, params: unknown) => {
    if (acknowledgements.size >= 32) throw new Error("SDK storage acknowledgements exceed budget");
    const id = `host:${++outbound}`;
    const completion = Promise.withResolvers<void>();
    void completion.promise.catch(() => {});
    const timer = setTimeout(() => {
      acknowledgements.delete(id);
      completion.reject(new Error("SDK storage acknowledgement expired"));
    }, 30000);
    acknowledgements.set(id, {
      resolve: () => completion.resolve(),
      reject: () => completion.reject(new Error("SDK storage refused frame")),
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
    const reply = z
      .object({ id: z.string(), result: z.unknown().optional(), error: z.unknown().optional() })
      .safeParse(decoded);
    if (reply.success && reply.data.id.startsWith("host:")) {
      const acknowledgement = acknowledgements.get(reply.data.id);
      if (!acknowledgement) {
        disconnected();
        return;
      }
      if (reply.data.error !== undefined) acknowledgement.reject();
      else acknowledgement.resolve();
      return;
    }
    if (++pending > 16) {
      disconnected();
      return;
    }
    void (async () => {
      let id: string | number | undefined;
      try {
        const request = Request.parse(decoded);
        id = request.id;
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
              data: { code: discoveryFailureCode(error) },
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
