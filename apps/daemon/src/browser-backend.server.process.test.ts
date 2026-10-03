import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BrowserService } from "@ace/browser";
import { BrowserBackendServerMessage, DeviceCredential } from "@ace/protocol";
import { fixture, token } from "./socket-test-support.ts";
import { RemoteAuth } from "./remote-auth.ts";
import { desktopCredential } from "./browser-desktop.ts";
import { readFile } from "node:fs/promises";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
const capabilities = {
  cdp: true,
  targets: true,
  permissions: true,
  downloads: true,
  controllerLease: true,
};
async function next(socket: WebSocket): Promise<unknown> {
  const raw: unknown = (await once(socket, "message"))[0];
  if (!Buffer.isBuffer(raw)) throw new Error("Expected socket data");
  return JSON.parse(raw.toString());
}
const register = async (socket: WebSocket, credentialToken: string) => {
  const reply = next(socket);
  socket.send(
    JSON.stringify({
      type: "browser.backend.register",
      requestId: "register",
      credential: credentialToken,
      version: 1,
      capabilities,
    }),
  );
  return reply;
};

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "ace-desktop-auth-"));
  const browser = new BrowserService({ dataDir: home });
  const f = await fixture({ browser });
  cleanups.push(async () => {
    await f.close();
    await browser.close();
    await rm(home, { recursive: true, force: true });
  });
  await desktopCredential(home, f.store.devices, () => 1);
  const credential = DeviceCredential.parse(
    JSON.parse(await readFile(join(home, "browser-desktop.json"), "utf8")),
  );
  const sockets: WebSocket[] = [];
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
  });
  const connect = async (deviceId: string, ticket?: string) => {
    const socket = new WebSocket(f.server.url);
    sockets.push(socket);
    await once(socket, "open");
    const welcome = next(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        deviceId,
        ...(ticket ? { ticket } : { token }),
      }),
    );
    expect(await welcome).toMatchObject({ type: "welcome" });
    return socket;
  };
  return { ...f, browser, credential, connect, register };
}
it("registers only a matching local desktop credential and refuses a second connected desktop", async () => {
  const f = await setup();
  const host = await f.connect("host");
  expect(await f.register(host, f.credential.token)).toMatchObject({
    type: "error",
    code: "browser_backend_denied",
  });
  const desktop = await f.connect(f.credential.device.id);
  expect(
    BrowserBackendServerMessage.parse(await f.register(desktop, f.credential.token)),
  ).toMatchObject({ type: "browser.backend.registered", backendId: expect.any(String) });
  const duplicate = await f.connect(f.credential.device.id);
  expect(await f.register(duplicate, f.credential.token)).toMatchObject({
    type: "error",
    message: expect.stringContaining("already registered"),
  });
});
it("desktop credentials cannot be paired or converted to remote socket tickets", async () => {
  const f = await setup();
  const auth = new RemoteAuth(f.store.devices, token, {
    now: () => 1,
    secret: () => "b".repeat(64),
  });
  expect(() => auth.pairing(["desktop"])).toThrow("local only");
  expect(() => auth.ticket(f.credential.device)).toThrow("local only");
});
it("revoking a desktop credential closes its registered backend socket", async () => {
  const f = await setup();
  const desktop = await f.connect(f.credential.device.id);
  const registration = await f.register(desktop, f.credential.token);
  expect(registration).toMatchObject({ type: "browser.backend.registered" });
  const closed = once(desktop, "close");
  f.store.devices.revoke(f.credential.device.id, 2);
  await closed;
  const reconnect = await f.connect(f.credential.device.id);
  expect(await f.register(reconnect, f.credential.token)).toMatchObject({
    type: "error",
    code: "browser_backend_denied",
  });
});
