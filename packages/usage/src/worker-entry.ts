import { parentPort, workerData } from "node:worker_threads";
import { WorkerConfig, WorkerRequest } from "./worker-wire.ts";
import { UsageStore } from "./store.ts";
const config = WorkerConfig.parse(workerData);
const store = new UsageStore(config.path, config.settings);
if (!parentPort) throw new Error("Usage worker requires parent port");
const port = parentPort;
port.on("message", (input: unknown) => {
  const { id, call } = WorkerRequest.parse(input);
  try {
    let value;
    switch (call.method) {
      case "cursor":
        value = store.cursor();
        break;
      case "ingest":
        value = store.ingest(call.batch);
        break;
      case "summary":
        value = store.summary(call.query);
        break;
      case "series":
        value = store.series(call.query);
        break;
      case "burn":
        value = store.burn(call.account, call.window, call.now);
        break;
      case "close":
        store.close();
        value = null;
        break;
    }
    port.postMessage({ id, ok: true, value });
    if (call.method === "close") port.close();
  } catch {
    port.postMessage({ id, ok: false });
  }
});
