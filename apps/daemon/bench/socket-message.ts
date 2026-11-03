/**
 * Allocation and CPU per WebSocket message a signed-in device sends, from the parsed JSON to the
 * typed message the socket services receive. Run: `node apps/daemon/bench/socket-message.ts`.
 */
import { getHeapStatistics } from "node:v8";
import { decodeDeviceFrame } from "../src/services/socket-message.ts";

const iterations = 10_000;
const rounds = 5;
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;

function measure(path: string, expected: "message" | "unsupported", frame: unknown) {
  const run = () => {
    for (let index = 0; index < iterations; index++)
      if (decodeDeviceFrame(frame).kind !== expected) throw new Error(`${path} decoded wrongly`);
  };
  for (let warm = 0; warm < 2; warm++) run();
  const allocated: number[] = [];
  const cpu: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const bytes = getHeapStatistics().total_allocated_bytes;
    const usage = process.cpuUsage();
    run();
    const spent = process.cpuUsage(usage);
    allocated.push((getHeapStatistics().total_allocated_bytes - bytes) / iterations);
    cpu.push((spent.user + spent.system) / iterations);
  }
  console.log(
    JSON.stringify({
      path,
      iterations,
      bytesPerMessage: Math.round(median(allocated)),
      cpuMicrosecondsPerMessage: Number(median(cpu).toFixed(2)),
    }),
  );
}

measure("desktop browser event (browser.backend.event)", "message", {
  type: "browser.backend.event",
  backendId: "backend",
  sessionId: "session",
  method: "ace.tabs.event",
  params: { tabId: "tab-1", method: "Network.dataReceived", params: { requestId: "r1" } },
});
measure("user browser extension event (user_browser.event)", "message", {
  type: "user_browser.event",
  event: { kind: "cdp", tabId: 1, method: "Network.dataReceived", params: {} },
});
measure("client message (presence.update)", "message", {
  type: "presence.update",
  threadId: null,
  inputAgeMs: 1200,
  appState: "foreground",
});
measure("unknown request type", "unsupported", { type: "nothing.here", requestId: "request-1" });
