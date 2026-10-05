// Merge-time measurement only. Do not run during development under the owner's rule.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { DeviceId, ProjectsRequest, type ProjectsResult } from "@ace/protocol";
import { Store } from "../src/store.ts";
import { Projects } from "../src/projects.ts";
import { startServer } from "../src/server.ts";
import { stubHandler } from "../src/commands.ts";
import { Client, token } from "../src/socket-test-support.ts";

// The daemon targets macOS/Linux. /tmp canonicalizes outside macOS's denied /var tree.
const home = await realpath(await mkdtemp("/tmp/ace-picker-benchmark-"));
const store = new Store(join(home, "events.sqlite"));
const projects = new Projects(store, () => 0, { home, roots: async () => [home] });
let closeServer: (() => Promise<void>) | undefined;
let client: Client | undefined;
let sequence = 0;
async function search(connection: Client, limit: number): Promise<ProjectsResult["result"]> {
  const requestId = `picker-benchmark-${++sequence}`;
  connection.send(
    ProjectsRequest.parse({
      type: "projects.request",
      requestId,
      operation: { op: "fs.search", query: "folder", limit, showHidden: false },
    }),
  );
  for (;;) {
    const message = await connection.next();
    if (message.type === "projects.result" && message.requestId === requestId) {
      if (message.result.kind === "error") throw new Error(message.result.code);
      return message.result;
    }
  }
}
try {
  // Bounded creation concurrency and no provider or network Git processes.
  for (let offset = 0; offset < 1100; offset += 50)
    await Promise.all(
      Array.from({ length: Math.min(50, 1100 - offset) }, (_, position) =>
        mkdir(join(home, `folder-${String(offset + position).padStart(4, "0")}`)),
      ),
    );
  const server = await startServer({
    store,
    projects,
    token,
    hostId: "picker-benchmark",
    port: 0,
    handler: stubHandler(),
  });
  closeServer = server.close;
  client = new Client(server.url);
  await once(client.socket, "open");
  client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("owner"), token });
  if ((await client.next()).type !== "welcome") throw new Error("Expected welcome");
  const cold = performance.now();
  const first = await search(client, 30);
  process.stdout.write(
    JSON.stringify({
      scenario: "cold",
      folders: 1100,
      elapsedMs: performance.now() - cold,
      indexing: first.kind === "search" && first.indexing,
    }) + "\n",
  );
  let ready = false;
  for (let slice = 0; slice < 200; slice++) {
    const result = await search(client, 30);
    if (result.kind === "search" && !result.indexing) {
      ready = true;
      break;
    }
  }
  if (!ready) throw new Error("Index did not finish within the benchmark's slice bound");
  for (const limit of [2, 30, 100]) {
    const times: number[] = [];
    const rssBefore = process.memoryUsage().rss;
    for (let sample = 0; sample < 50; sample++) {
      const started = performance.now();
      const result = await search(client, limit);
      times.push(performance.now() - started);
      if (result.kind !== "search" || result.entries.length !== limit)
        throw new Error("Warm search did not fill the requested page");
    }
    times.sort((a, b) => a - b);
    const medianMs = times[25];
    process.stdout.write(
      JSON.stringify({
        scenario: "warm",
        folders: 1100,
        limit,
        samples: times.length,
        medianMs,
        p95Ms: times[47],
        maximumMs: times.at(-1),
        rssGrowthMiB: (process.memoryUsage().rss - rssBefore) / 1024 / 1024,
      }) + "\n",
    );
    if (medianMs === undefined || medianMs >= 100) throw new Error("Warm median exceeded 100 ms");
  }
} finally {
  await client?.close();
  await closeServer?.();
  await projects.close();
  await store.close();
  await rm(home, { recursive: true, force: true });
}
