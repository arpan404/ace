import { parentPort, workerData } from "node:worker_threads";
import { NotificationService, type DeliveryResult } from "./service.ts";
import { ToWorker, WorkerConfig } from "./worker-wire.ts";

const port = parentPort;
if (!port) throw new Error("Notification worker requires a parent");
const config = WorkerConfig.parse(workerData);
let sequence = 0;
const sends = new Map<number, (result: DeliveryResult) => void>();
const service = new NotificationService({
  ...config,
  now: Date.now,
  jitter: Math.random,
  transport: {
    async send(device, notification, signal) {
      const id = ++sequence;
      return new Promise<DeliveryResult>((resolve) => {
        const abort = () => {
          port.postMessage({ type: "cancel", id });
          finish("retry");
        };
        const finish = (result: DeliveryResult) => {
          sends.delete(id);
          signal.removeEventListener("abort", abort);
          resolve(result);
        };
        sends.set(id, finish);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else port.postMessage({ type: "delivery", id, device, notification });
      });
    },
  },
});
port.on("message", (input: unknown) => {
  const message = ToWorker.parse(input);
  if (message.type === "deliveryResult") {
    sends.get(message.id)?.(message.result);
    return;
  }
  const { call, id } = message;
  // Calls are synchronous except drain/close. Delivery replies must remain able to complete a drain.
  void (async () => {
    let value: number | undefined;
    try {
      switch (call.method) {
        case "cursor":
          value = service.cursor();
          break;
        case "ingest":
          service.ingest(call.events, call);
          break;
        case "register":
          service.register(call.device, call.address);
          break;
        case "connectDevice":
          service.connectDevice(call.device);
          break;
        case "preferences":
          service.preferences(call.device, call.preferences);
          break;
        case "revoke":
          service.revoke(call.device);
          break;
        case "snooze":
          service.snooze(call.thread, call.until);
          break;
        case "presence":
          service.updatePresence(call.session, call.device, call.update);
          break;
        case "disconnect":
          service.disconnect(call.session);
          break;
        case "drain":
          await service.drain();
          break;
        case "close":
          await service.close();
          break;
      }
      port.postMessage({ type: "result", id, ok: true, ...(value === undefined ? {} : { value }) });
      if (call.method === "close") port.close();
    } catch {
      port.postMessage({ type: "result", id, ok: false });
    }
  })();
});
