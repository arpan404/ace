// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
// The worker half of koffi-main.ts: built as the probe worker's bundle, so it loads from where
// the app's probe worker does.
import { parentPort } from "node:worker_threads";
import { koffiFacts } from "./koffi-call.ts";

if (!parentPort) throw new Error("This stand-in runs only as a worker thread");
parentPort.postMessage(koffiFacts());
