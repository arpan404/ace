import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SocketTicket } from "@ace/protocol";
import { Store, stubHandler } from "./index.ts";
import { startServer } from "./server.ts";
import { accessRequest } from "./client-access.ts";

// Informational benchmark: real HTTP, SQLite and crypto; no performance gating.
const home = mkdtempSync(join(tmpdir(), "ace-ticket-bench-"));
const store = new Store(join(home, "events.sqlite"));
const token = "a".repeat(64);
const server = await startServer({
  port: 0,
  token,
  hostId: "bench",
  store,
  handler: stubHandler(),
  now: () => 1000,
});
try {
  const devices = Array.from({ length: 314 }, (_, i) =>
    store.devices.create(`Device ${i}`, ["read"], 1000),
  );
  for (let i = 0; i < 100; i++) await accessRequest(server.httpUrl, "/v1/status", { token });
  global.gc?.();
  const initialHeap = process.memoryUsage().heapUsed;
  let retained = 0;
  const batches = [];
  for (const count of [1000, 3000, 6000]) {
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      const device = devices[retained % devices.length];
      if (!device) throw new Error("Missing benchmark device");
      SocketTicket.parse(
        await accessRequest(server.httpUrl, "/v1/tickets", {
          method: "POST",
          token: device.token,
        }),
      );
      retained++;
    }
    const elapsedMs = performance.now() - start;
    batches.push({ count, retained, elapsedMs, msPerRequest: elapsedMs / count });
  }
  global.gc?.();
  console.log(
    JSON.stringify({
      node: process.version,
      devices: devices.length,
      batches,
      retainedHeapBytes: process.memoryUsage().heapUsed - initialHeap,
    }),
  );
} finally {
  await server.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
}
