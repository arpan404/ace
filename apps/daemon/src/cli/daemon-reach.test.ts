import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { cliExitCodes } from "@ace/protocol/cli-output";
import { reachLocalDaemon } from "./connection.ts";
import { toCliError } from "./errors.ts";

const homes: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(port?: number): string {
  const dir = mkdtempSync(join(tmpdir(), "ace-reach-"));
  homes.push(dir);
  if (port !== undefined) {
    writeFileSync(join(dir, "daemon-endpoint"), `http://127.0.0.1:${port}/`);
    writeFileSync(join(dir, "daemon-token"), "a".repeat(64));
  }
  return dir;
}

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.end());
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return toCliError(error);
}

test("a home with no endpoint file reads as ace isn't running, exit 4", async () => {
  const error = await failure(reachLocalDaemon(home()));
  expect(error).toMatchObject({
    code: "daemon_down",
    status: "refused",
    error: "ace isn't running.",
  });
  expect(cliExitCodes[error.status]).toBe(4);
  expect(error.hint).toMatch(/ace start/);
});

test("an endpoint a stopped daemon left behind reads as down within the probe, not a 15 s wait", async () => {
  const { server, port } = await listen();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const started = performance.now();
  const error = await failure(reachLocalDaemon(home(port)));
  expect(error.code).toBe("daemon_down");
  expect(performance.now() - started).toBeLessThan(1_500);
});

test("a probe that never answers counts as down", async () => {
  const error = await failure(reachLocalDaemon(home(4), async () => false));
  expect(error.code).toBe("daemon_down");
});

test("a daemon listening on its endpoint is reached", async () => {
  const { server, port } = await listen();
  servers.push(server);
  await expect(reachLocalDaemon(home(port))).resolves.toEqual({
    origin: `http://127.0.0.1:${port}/`,
    token: "a".repeat(64),
  });
});
