import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { daemonHealth, type LocalDaemon } from "./probe.ts";

const token = "ab".repeat(32);
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A daemon's status endpoint answering `body` to its host token. */
async function daemonAnswering(body: unknown): Promise<LocalDaemon> {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, url: `ws://127.0.0.1:${port}/`, token };
}

describe("a health check across daemon versions", () => {
  it("reads admission from a daemon that includes it in its status", async () => {
    const daemon = await daemonAnswering({
      running: true,
      ready: true,
      version: "development",
      admission: { draining: true, blockers: 0, holds: ["user"] },
    });
    expect(await daemonHealth(daemon)).toEqual({
      healthy: true,
      admission: { draining: true, holds: ["user"] },
    });
  });

  it("still counts an older daemon without admission as healthy, so admission is read apart", async () => {
    const daemon = await daemonAnswering({ running: true, version: "development" });
    expect(await daemonHealth(daemon)).toEqual({ healthy: true });
  });

  it("counts a daemon that is not ready yet as not healthy", async () => {
    const daemon = await daemonAnswering({ running: true, ready: false, version: "development" });
    expect(await daemonHealth(daemon)).toEqual({ healthy: false });
  });
});
