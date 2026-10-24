/**
 * A notification worker that dies right after it replies to the ingest call carrying a
 * needs-you status, before it can report its new deadline. `workerData.entry` is the real
 * worker entry, loaded after the port is wrapped.
 */
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

const port = parentPort;
if (!port) throw new Error("Crash helper requires a parent");
const { entry } = z.object({ entry: z.string() }).parse(workerData);
const Call = z.object({ type: z.literal("call"), id: z.number() });
const Result = z.object({ type: z.literal("result"), id: z.number() });
const fatal = new Set<number>();
port.on("message", (input: unknown) => {
  const call = Call.safeParse(input);
  if (call.success && JSON.stringify(input).includes('"needs_you"')) fatal.add(call.data.id);
});
const post = port.postMessage.bind(port);
Reflect.set(port, "postMessage", (message: unknown) => {
  post(message);
  const result = Result.safeParse(message);
  if (result.success && fatal.has(result.data.id)) process.exit(1);
});
await import(entry);
