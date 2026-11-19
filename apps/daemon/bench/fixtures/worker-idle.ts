import { parentPort } from "node:worker_threads";

parentPort?.postMessage("ready");
setInterval(() => {}, 1000);
