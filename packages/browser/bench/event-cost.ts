/**
 * Allocation and CPU per browser event on the daemon's hot paths: a desktop backend message
 * through `EmbeddedBackend.handle`, and CDP network/page events through the inspection and
 * page-status listeners every tab carries. Run: `node packages/browser/bench/event-cost.ts`.
 */
import { EventEmitter } from "node:events";
import { getHeapStatistics } from "node:v8";
import { BrowserOpen, type BrowserBackendClientMessage } from "@ace/protocol";
import { EmbeddedBackend } from "../src/index.ts";
import { BrowserInspection } from "../src/inspection.ts";
import { pageStatus } from "../src/page-status.ts";
import type { BrowserCdp } from "../src/backend.ts";

const iterations = 10_000;
const rounds = 5;
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;

function measure(path: string, run: () => void) {
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
      bytesPerEvent: Math.round(median(allocated)),
      cpuMicrosecondsPerEvent: Number(median(cpu).toFixed(2)),
    }),
  );
}

let sessionId = "";
const backend = new EmbeddedBackend(
  "bench",
  {
    send(message) {
      if (message.type !== "browser.backend.request") return true;
      if (message.operation.kind === "open") sessionId = message.sessionId;
      backend.handle({
        type: "browser.backend.response",
        backendId: message.backendId,
        sessionId: message.sessionId,
        id: message.id,
        result: message.operation.kind === "open" ? { url: "about:blank" } : {},
      });
      return true;
    },
    close() {},
  },
  () => {},
);
const session = await backend.open({
  options: BrowserOpen.parse({ threadId: "thread", workspaceId: "workspace" }),
  profileDir: "/unused",
  signal: new AbortController().signal,
  allowed: async () => true,
  navigation() {},
  log() {},
  lost() {},
});
session.cdp.on("ace.tabs.event", () => {});

const tabEvents: BrowserBackendClientMessage[] = [
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.dataReceived",
  "Network.loadingFinished",
  "Runtime.consoleAPICalled",
].map((method, index) => ({
  type: "browser.backend.event",
  backendId: "bench",
  sessionId,
  method: "ace.tabs.event",
  params: { tabId: "tab-1", method, params: { requestId: `r${index}`, timestamp: index } },
}));
measure("embedded backend: ace.tabs.event message", () => {
  for (let index = 0; index < iterations; index++)
    backend.handle(tabEvents[index % tabEvents.length] as BrowserBackendClientMessage);
});

const cdp = new EventEmitter();
const fakeCdp: BrowserCdp = {
  send: async () => ({}),
  on: (method, listener) => cdp.on(method, listener),
  off: (method, listener) => cdp.off(method, listener),
};
const inspection = new BrowserInspection(() => {});
await inspection.attach(fakeCdp, "tab-1");
const status = pageStatus(fakeCdp, () => {});
const request = (id: number) => ({
  requestId: `r${id}`,
  frameId: "main",
  type: "Fetch",
  timestamp: id,
  request: { url: `https://example.test/api/${id}?token=abc`, method: "GET" },
});
measure("inspection + page status: one network request (5 CDP events)", () => {
  for (let index = 0; index < iterations; index++) {
    const id = index % 150;
    cdp.emit("Network.requestWillBeSent", request(id));
    cdp.emit("Network.responseReceived", {
      requestId: `r${id}`,
      response: { url: `https://example.test/api/${id}`, status: 200, mimeType: "text/json" },
    });
    cdp.emit("Network.dataReceived", { requestId: `r${id}`, dataLength: 512 });
    cdp.emit("Network.loadingFinished", { requestId: `r${id}`, encodedDataLength: 512 });
    cdp.emit("Page.frameStartedLoading", { frameId: "main" });
  }
});
status.close();
inspection.detach(fakeCdp);
await session.close();
backend.disconnect("Finished");
