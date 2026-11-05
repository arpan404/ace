// A stand-in for the app's main entry (koffi.process.test.ts): bundled the way the main process
// is, it makes native calls through koffi itself and from a worker bundle where the probe worker
// sits, in app.asar.unpacked, and prints what each returned.
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { bundledWorkerUrl } from "../../bundled-worker.ts";
import { PROBE_WORKER_BUNDLE } from "../toolchains.ts";
import { koffiFacts } from "./koffi-call.ts";

const worker = new Worker(bundledWorkerUrl(import.meta.url, PROBE_WORKER_BUNDLE));
const [fromWorker]: unknown[] = await once(worker, "message");
await worker.terminate();
const report = { pid: process.pid, main: koffiFacts(), worker: fromWorker };
process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0));
