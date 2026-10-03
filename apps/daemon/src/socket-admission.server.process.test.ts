import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { DeviceId } from "@ace/protocol";
import { Client, fixture, token } from "./socket-test-support.ts";
import { setup } from "./remote-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

/** The HTTP status of a refused upgrade, or 101 when the socket opened. */
async function upgrade(url: string, origin?: string): Promise<number> {
  const client = new Client(url, origin === undefined ? {} : { origin });
  const status = new Promise<number>((resolve) => {
    client.socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    client.socket.once("open", () => resolve(101));
  });
  client.socket.on("error", () => {});
  const result = await status;
  if (result === 101) cleanups.push(() => client.close());
  else client.socket.terminate();
  return result;
}
async function hello(client: Client): Promise<void> {
  client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("device"), token });
  expect(await client.next()).toMatchObject({ type: "welcome" });
}

test("a page on another origin cannot open the loopback socket, while allowed and native clients can", async () => {
  const f = await fixture({ webOrigins: ["http://localhost:5173"] });
  cleanups.push(() => f.close());
  expect(await upgrade(f.server.url, "https://attacker.example")).toBe(403);
  const page = new Client(f.server.url, { origin: "http://localhost:5173" });
  cleanups.push(() => page.close());
  await once(page.socket, "open");
  await hello(page);
  const native = await f.open();
  await hello(native);
});

test("a socket that never says hello is terminated at the hello deadline", async () => {
  const f = await fixture({ preAuth: { helloMs: 200 } });
  cleanups.push(() => f.close());
  const authenticated = await f.open();
  await hello(authenticated);
  const silent = await f.open();
  const closed = once(silent.socket, "close").then(([code]) => code);
  expect(await closed).toBe(1006);
  authenticated.send({ type: "ping" });
  expect(await authenticated.next()).toEqual({ type: "pong" });
});

test("anonymous loopback sockets are capped without counting authenticated ones", async () => {
  const f = await fixture({ preAuth: { local: 4, helloMs: 300 } });
  cleanups.push(() => f.close());
  // More authenticated clients than the anonymous budget: none of them hold a pre-auth slot.
  for (let i = 0; i < 6; i++) await hello(await f.open());
  const silent = await Promise.all(Array.from({ length: 4 }, () => f.open()));
  expect(await upgrade(f.server.url)).toBe(503);
  // Once the silent peers miss their deadline, a real client is admitted again.
  await Promise.all(silent.map((client) => once(client.socket, "close")));
  await hello(await f.open());
});

test("one remote address cannot take the remote budget or the loopback desktop's", async () => {
  const f = await setup({ preAuth: { perAddress: 2, helloMs: 60_000 } });
  const remote = f.server.remoteUrl;
  const tls = { rejectUnauthorized: false };
  for (let i = 0; i < 2; i++) {
    const silent = new Client(remote, tls);
    cleanups.push(() => silent.close());
    await once(silent.socket, "open");
  }
  const refused = new Client(remote, tls);
  refused.socket.on("error", () => {});
  const [, response] = await once(refused.socket, "unexpected-response");
  expect(response.statusCode).toBe(503);
  refused.socket.terminate();
  await hello(await f.open());
});
