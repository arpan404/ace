import { PriceRefresh } from "./price-refresh.ts";
import { join, dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { WorkerConfig, WorkerRequest } from "./worker-wire.ts";
import { UsageStore } from "./store.ts";
const config = WorkerConfig.parse(workerData);
let activePrices = config.settings.prices;
let target: UsageStore | undefined;
const refresh = new PriceRefresh(
  join(dirname(config.path), "usage-price-cache.json"),
  config.settings,
  Date.now,
  fetch,
  (prices) => {
    activePrices = prices;
    target?.updatePrices(prices);
  },
  () => console.warn("Usage price refresh failed; keeping last good prices"),
);
await refresh.load();
const store = new UsageStore(config.path, { ...config.settings, prices: activePrices });
target = store;
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
        void refresh.refresh(store.modelsInUse());
        break;
      case "sessionTotals":
        value = store.sessionTotalsFor(call.query);
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
        void refresh.close();
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
