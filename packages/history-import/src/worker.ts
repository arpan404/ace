import { parentPort, workerData } from "node:worker_threads";
import { mkdir, chmod, realpath, open, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate } from "node:timers/promises";
import { contains } from "@ace/native-session";
import { Archive } from "./archive.ts";
import { Catalog } from "./catalog.ts";
import { Envelope, Options, type Packet, type ImportInit } from "./contracts.ts";
import { scan } from "./scan.ts";
import { importHistory } from "./import-history.ts";

const options = Options.parse(workerData);
await mkdir(dirname(options.indexPath), { recursive: true, mode: 0o700 });
const indexParent = await realpath(dirname(options.indexPath));
for (const instance of options.instances) {
  let home = instance.homeDir;
  try {
    home = await realpath(home);
  } catch {
    /* missing homes list empty */
  }
  if (contains(home, indexParent)) throw new Error("ace index must be outside provider homes");
}
try {
  const info = await lstat(options.indexPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("ace index must be a regular file");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
const file = await open(options.indexPath, "a", 0o600);
await file.close();
await chmod(options.indexPath, 0o600);
const catalog = new Catalog(options.indexPath);
const archive = new Archive(catalog.db);
let controller = new AbortController();
let iterator: AsyncGenerator<Packet> | undefined;
let busy = false;
const port = parentPort;
if (!port) throw new Error("History worker needs a parent port");
port.on("message", async (value: unknown) => {
  if (value === "cancel") {
    controller.abort();
    return;
  }
  const parsed = Envelope.safeParse(value);
  if (!parsed.success) return;
  const { id, request } = parsed.data;
  if (busy) {
    port.postMessage({ id, error: "History operation already in progress" });
    return;
  }
  busy = true;
  try {
    let result: unknown;
    if (request.op === "archive.write") {
      archive.write(request.command);
      result = null;
    } else if (request.op === "archive.thread") result = archive.get(request.id);
    else if (request.op === "archive.agents") result = archive.agents(request.id);
    else if (request.op === "archive.page") result = archive.page(request.request);
    else if (request.op === "archive.blob") result = archive.readBlob(request.request);
    else if (request.op === "scan") {
      controller = new AbortController();
      result = await scan(catalog, options.instances, controller.signal, (files) =>
        port.postMessage({ progress: files }),
      );
    } else if (request.op === "list") result = catalog.list(request.request);
    else if (request.op === "get") result = catalog.get(request.id)?.summary ?? null;
    else if (request.op === "import.persist") {
      controller = new AbortController();
      result = await persistImport(request.init);
    } else if (request.op === "import") {
      if (iterator) throw new Error("Import already in progress");
      controller = new AbortController();
      iterator = importHistory(catalog, options.instances, request.init, controller.signal);
      result = await pullPackets(1);
    } else if (request.op === "next") {
      if (!iterator) throw new Error("No import in progress");
      // Receive cancellations even when the next source is entirely synchronous SQLite.
      await setImmediate();
      controller.signal.throwIfAborted();
      result = await pullPackets(16);
    } else if (request.op === "return") {
      if (iterator) await iterator.return(undefined);
      iterator = undefined;
      result = null;
    } else {
      const unhandled: never = request;
      throw new Error(`Unhandled history request: ${String(unhandled)}`);
    }
    const transfers: ArrayBuffer[] = [];
    if (
      result &&
      typeof result === "object" &&
      "values" in result &&
      Array.isArray(result.values)
    ) {
      for (const packet of result.values)
        if (packet.type === "blob.chunk" && packet.bytes.buffer instanceof ArrayBuffer)
          transfers.push(packet.bytes.buffer);
    }
    port.postMessage({ id, value: result }, transfers);
  } catch (error) {
    if (iterator) {
      await iterator.return(undefined);
      iterator = undefined;
    }
    port.postMessage({
      id,
      error: error instanceof Error ? error.message : "History operation failed",
    });
  } finally {
    busy = false;
  }
});
port.postMessage({ id: 0, value: "ready" });

async function pullPackets(limit: number): Promise<{ done: boolean; values: Packet[] }> {
  const values: Packet[] = [];
  while (values.length < limit && iterator) {
    controller.signal.throwIfAborted();
    const next = await iterator.next();
    if (next.done) {
      iterator = undefined;
      return { done: true, values };
    }
    values.push(next.value);
    if (next.value.type === "barrier") break;
  }
  return { done: false, values };
}

async function persistImport(init: ImportInit) {
  let began = false;
  let count = 0;
  let accuracy: "exact" | "sampled" = "sampled";
  let ended = false;
  let packets = 0;
  try {
    for await (const packet of importHistory(catalog, options.instances, init, controller.signal)) {
      if (++packets % 16 === 0) await setImmediate();
      controller.signal.throwIfAborted();
      if (packet.type === "thread") {
        archive.write({ type: "begin", thread: packet.thread });
        began = true;
      } else if (packet.type === "agent") archive.write({ type: "agent", agent: packet.agent });
      else if (packet.type === "item") archive.write({ type: "item", item: packet.item });
      else if (
        packet.type === "blob.start" ||
        packet.type === "blob.chunk" ||
        packet.type === "blob.end"
      )
        archive.write(packet);
      else if (packet.type === "end") {
        count = packet.messageCount;
        accuracy = packet.countAccuracy;
        ended = true;
      }
    }
    controller.signal.throwIfAborted();
    if (!ended) throw new Error("Incomplete history import");
    archive.write({ type: "commit" });
    return { messageCount: count, countAccuracy: accuracy };
  } catch (error) {
    if (began) archive.write({ type: "rollback" });
    throw error;
  }
}
