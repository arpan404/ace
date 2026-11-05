// The worker half of koffi-main.ts: built as the probe worker's bundle, so it loads from where
// the app's probe worker does.
import { parentPort } from "node:worker_threads";
import { koffiFacts } from "./koffi-call.ts";

parentPort?.postMessage(koffiFacts());
