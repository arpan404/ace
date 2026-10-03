import { performance } from "node:perf_hooks";
import { EmbeddedBackend } from "../src/index.ts";
import { BrowserOpen } from "@ace/protocol";
let latestSession = "";
let holdReads = false;
const backend = new EmbeddedBackend(
  "bench",
  {
    send(message) {
      if (message.type === "browser.backend.request") {
        if (message.operation.kind === "open") latestSession = message.sessionId;
        if (
          holdReads &&
          message.operation.kind === "cdp" &&
          message.operation.method === "Runtime.getProperties"
        )
          return true;
        backend.handle({
          type: "browser.backend.response",
          backendId: message.backendId,
          sessionId: message.sessionId,
          id: message.id,
          result: message.operation.kind === "open" ? { url: "about:blank" } : {},
        });
      }
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
function report(path: string, iterations: number, start: number) {
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      path,
      iterations,
      opsPerSecond: (iterations * 1000) / elapsed,
      microseconds: (elapsed * 1000) / iterations,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
}
let start = performance.now();
for (let index = 0; index < 100_000; index++) await session.cdp.send("Memory.getDOMCounters");
report("relay command serialization, admission and response", 100_000, start);
const frame = {
  type: "browser.backend.event",
  backendId: "bench",
  sessionId: "bench-1",
  method: "Page.screencastFrame",
  params: {
    sessionId: 1,
    data: "x".repeat(512 * 1024),
    metadata: { deviceWidth: 1280, deviceHeight: 720 },
  },
};
let received = 0;
session.cdp.on("Page.screencastFrame", () => {
  received++;
});
start = performance.now();
for (let index = 0; index < 100_000; index++) backend.handle(frame);
report("relay frame validation and acknowledgement", received, start);
await session.close();
const options = {
  options: BrowserOpen.parse({ threadId: "lost", workspaceId: "workspace" }),
  profileDir: "/unused",
  signal: new AbortController().signal,
  allowed: async () => true,
  navigation() {},
  log() {},
  lost() {},
};
const sibling = await backend.open(options);
holdReads = true;
const held = Promise.allSettled(
  Array.from({ length: 112 }, () => sibling.cdp.send("Runtime.getProperties")),
);
start = performance.now();
for (let index = 0; index < 1000; index++) {
  const detached = await backend.open(options);
  const target = latestSession;
  const reads = Promise.allSettled(
    Array.from({ length: 8 }, () => detached.cdp.send("Runtime.getProperties")),
  );
  backend.handle({
    type: "browser.backend.event",
    backendId: "bench",
    sessionId: target,
    method: "Inspector.detached",
    params: {},
  });
  await reads;
}
report("view open and detach with 8 affected and 112 unrelated pending reads", 1000, start);
await sibling.close();
await held;
backend.disconnect("Finished");
