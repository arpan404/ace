import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BrowserService } from "@ace/browser";
import { FilesService } from "@ace/files";
import { encodeEmbeddedVideo } from "@ace/browser/video-encoder";
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
  humanInput: true,
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

async function setup(options: { files?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "ace-desktop-auth-"));
  const browser = new BrowserService({ dataDir: home });
  const files = options.files
    ? await FilesService.create({
        workspace: home,
        dataDir: home,
        now: () => 1,
        id: () => "file-id",
        authorize: () => true,
      })
    : undefined;
  const f = await fixture({ browser, ...(files ? { files } : {}) });
  cleanups.push(async () => {
    await f.close();
    await browser.close();
    await files?.close();
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
it("HTTP revocation closes the desktop backend even when another revocation listener throws", async () => {
  const f = await setup();
  const stopThrowing = f.store.devices.onRevoke(() => {
    throw new Error("Unrelated listener failure");
  });
  cleanups.push(async () => stopThrowing());
  const desktop = await f.connect(f.credential.device.id);
  const registration = await f.register(desktop, f.credential.token);
  expect(registration).toMatchObject({ type: "browser.backend.registered" });
  const closed = once(desktop, "close");
  const response = await fetch(`${f.server.httpUrl}/v1/devices/${f.credential.device.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ revoked: true });
  expect(f.store.devices.get(f.credential.device.id)?.revokedAt).not.toBeNull();
  await closed;
  const reconnect = await f.connect(f.credential.device.id);
  expect(await f.register(reconnect, f.credential.token)).toMatchObject({
    type: "error",
    code: "browser_backend_denied",
  });
});
it("takes a registered desktop's video encoder events as binary messages on its backend socket", async () => {
  const f = await setup({ files: true });
  const desktop = await f.connect(f.credential.device.id);
  const reply = next(desktop);
  desktop.send(
    JSON.stringify({
      type: "browser.backend.register",
      requestId: "register",
      credential: f.credential.token,
      version: 1,
      capabilities: { ...capabilities, video: true },
    }),
  );
  expect(await reply).toMatchObject({ type: "browser.backend.registered" });
  // An encoder event for a capture that already closed: taken and dropped, never refused as a
  // message no channel takes (the files channel claims binary messages too).
  desktop.send(encodeEmbeddedVideo({ t: "ended", capture: "closed-capture" }));
  const pong = next(desktop);
  desktop.send(JSON.stringify({ type: "ping" }));
  expect(await pong).toEqual({ type: "pong" });
  expect(desktop.readyState).toBe(WebSocket.OPEN);
});
