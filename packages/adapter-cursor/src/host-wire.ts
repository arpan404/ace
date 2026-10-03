import { createInterface } from "node:readline";
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
  process.stderr.write = () => true;
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
    if (++pending > 16) {
      disconnected();
      return;
    }
    void (async () => {
      let id: string | number | undefined;
      try {
        const request = Request.parse(JSON.parse(line));
        id = request.id;
        const result = await dispatch(request.method, request.params);
        await send({ jsonrpc: "2.0", id, result: result ?? null });
      } catch {
        // Never pass vendor exception text, stacks, request headers or auth returns.
        if (id !== undefined)
          await send({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: "Cursor SDK operation failed; check safe lifecycle notice",
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
  return { notify: (method: string, params: unknown) => send({ jsonrpc: "2.0", method, params }) };
}
