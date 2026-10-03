import { performance } from "node:perf_hooks";
import { EmbeddedBackend } from "../src/index.ts";
import { BrowserOpen } from "@ace/protocol";
const backend = new EmbeddedBackend(
  "bench",
  {
    send(message) {
      if (message.type === "browser.backend.request")
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
backend.disconnect("Finished");
