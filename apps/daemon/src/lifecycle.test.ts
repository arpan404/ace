import { DatabaseSync } from "node:sqlite";
import { request as httpRequest } from "node:http";
import { connect as connectTcp } from "node:net";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceId } from "@ace/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "./index.ts";
import { readConfig } from "./config.ts";
import { launchDaemon } from "./process-test-support.ts";
import { Client } from "./socket-test-support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ace-lifecycle-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
function launch(home: string) {
  const launched = launchDaemon(
    { ...process.env, ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent", ACE_DEV: "1" },
    /ace daemon: ws:\/\/127\.0\.0\.1:\d+\n/,
    cleanups,
  );
  return {
    ...launched,
    ready: launched.ready.then((output) => {
      const url = /ace daemon: (ws:\/\/127\.0\.0\.1:\d+)\n/.exec(output)?.[1];
      if (!url) throw new Error("Missing daemon URL");
      return url;
    }),
  };
}
async function connect(url: string, home: string): Promise<Client> {
  const client = new Client(url);
  cleanups.push(() => client.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("device"),
    token: readFileSync(join(home, "daemon-token"), "utf8"),
  });
  return client;
}
describe("daemon lifecycle", () => {
  it("starts from config, keeps its token private and permits a graceful reopen", async () => {
    const home = tempHome();
    const config = readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" });
    const daemon = await startDaemon(config);
    cleanups.push(() => daemon.close());
    const token = readFileSync(daemon.tokenPath, "utf8");
    expect(statSync(daemon.tokenPath).mode & 0o777).toBe(0o600);
    const client = await connect(daemon.url, home);
    const first = await client.next();
    expect(first).toMatchObject({ type: "welcome", headSeq: 0 });
    const closed = once(client.socket, "close");
    await daemon.close();
    await closed;
    const reopened = await startDaemon(config);
    cleanups.push(() => reopened.close());
    expect(readFileSync(reopened.tokenPath, "utf8")).toBe(token);
    const again = await connect(reopened.url, home);
    expect(await again.next()).toEqual(first);
  });
  it("prevents a second process sharing the database and restarts after SIGTERM", async () => {
    const home = tempHome();
    const first = launch(home);
    const url = await first.ready;
    const second = launch(home);
    // Read the failure through the public CLI process outcome.
    await expect(second.ready).rejects.toThrow("Cannot acquire daemon lock");
    expect((await second.exited)[0]).toBe(1);
    const client = await connect(url, home);
    const welcome = await client.next();
    expect(welcome).toMatchObject({ type: "welcome", headSeq: 1 });
    const closed = once(client.socket, "close");
    first.child.kill("SIGTERM");
    expect((await first.exited)[0]).toBe(0);
    await closed;
    const third = launch(home);
    const restarted = await connect(await third.ready, home);
    expect(await restarted.next()).toEqual(welcome);
  });
  it("releases the instance lock after a crash and preserves committed events", async () => {
    const home = tempHome();
    const first = launch(home);
    const client = await connect(await first.ready, home);
    const welcome = await client.next();
    const closed = once(client.socket, "close");
    first.child.kill("SIGKILL");
    await first.exited;
    await closed;
    const restarted = launch(home);
    const again = await connect(await restarted.ready, home);
    expect(await again.next()).toEqual(welcome);
    again.send({ type: "subscribe", subscriptionId: "s", scope: { kind: "threads" }, afterSeq: 0 });
    expect(await again.next()).toMatchObject({
      type: "events",
      events: [{ seq: 1, payload: { type: "thread.created" } }],
    });
  });
  it("unwinds a failed bind so the same data directory can start again", async () => {
    const firstHome = tempHome();
    const first = await startDaemon(
      readConfig({ ACE_HOME: firstHome, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    );
    cleanups.push(() => first.close());
    const secondHome = tempHome();
    const port = new URL(first.url).port;
    await expect(
      startDaemon(readConfig({ ACE_HOME: secondHome, ACE_PORT: port, ACE_LOG_LEVEL: "silent" })),
    ).rejects.toThrow("EADDRINUSE");
    const second = await startDaemon(
      readConfig({ ACE_HOME: secondHome, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    );
    cleanups.push(() => second.close());
    const client = await connect(second.url, secondHome);
    expect(await client.next()).toMatchObject({ type: "welcome", headSeq: 0 });
  });
  it("rejects a newer database schema and releases its startup lock", async () => {
    const home = tempHome();
    const config = readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" });
    const first = await startDaemon(config);
    await first.close();
    const database = new DatabaseSync(join(home, "events.sqlite"));
    const original = database.prepare("SELECT version FROM schema_version").get();
    if (!original || typeof original.version !== "number")
      throw new Error("Expected schema version");
    database.prepare("UPDATE schema_version SET version = 999").run();
    database.close();
    const attempt = startDaemon(config);
    void attempt.then(
      (daemon) => {
        cleanups.push(() => daemon.close());
      },
      () => {},
    );
    await expect(attempt).rejects.toThrow("newer than this daemon");
    const restored = new DatabaseSync(join(home, "events.sqlite"));
    restored.prepare("UPDATE schema_version SET version = ?").run(original.version);
    restored.close();
    const again = await startDaemon(config);
    cleanups.push(() => again.close());
    expect(again.store.headSeq()).toBe(0);
  });
});

it("keeps the daemon alive when an excess upgrade includes an oversized frame", async () => {
  const home = tempHome();
  const daemon = launch(home);
  const url = await daemon.ready;
  const clients = await Promise.all(
    Array.from({ length: 256 }, async () => {
      const client = new Client(url);
      cleanups.push(() => client.close());
      await once(client.socket, "open");
      return client;
    }),
  );
  const socket = connectTcp({ host: "127.0.0.1", port: Number(new URL(url).port) });
  cleanups.push(() => {
    socket.destroy();
  });
  await once(socket, "connect");
  let response = "";
  socket.on("data", (chunk) => {
    response += chunk.toString();
  });
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  // Put the invalid frame in the upgrade head, before admission can finish.
  const frame = Buffer.alloc(14 + 1024 * 1024 + 1);
  frame[0] = 0x81;
  frame[1] = 0xff;
  frame.writeBigUInt64BE(BigInt(1024 * 1024 + 1), 2);
  socket.write(
    Buffer.concat([
      Buffer.from(
        "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      ),
      frame,
    ]),
  );
  await closed;
  const client = clients[0];
  if (!client) throw new Error("Missing admitted client");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("probe"),
    token: readFileSync(join(home, "daemon-token"), "utf8"),
  });
  expect(
    await Promise.race([
      client.next(),
      daemon.exited.then(() => {
        throw new Error("Daemon exited after excess upgrade");
      }),
    ]),
  ).toMatchObject({ type: "welcome" });
  expect(response).not.toContain("101 Switching Protocols");
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(url.replace("ws:", "http:"), {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    request.on("response", (reply) => {
      reply.resume();
      resolve(reply.statusCode ?? 0);
    });
    request.on("upgrade", (_response, upgraded) => {
      upgraded.destroy();
      resolve(101);
    });
    request.on("error", reject);
    request.end();
  });
  expect(status).toBe(503);
  daemon.child.kill("SIGTERM");
  expect((await daemon.exited)[0]).toBe(0);
});
