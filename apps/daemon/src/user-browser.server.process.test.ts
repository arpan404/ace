import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { DeviceCredential, UserBrowserSettingsResult } from "@ace/protocol";
import { hostCredentialPath } from "@ace/browser-extension";
import { fixture } from "./socket-test-support.ts";
import { UserBrowserService } from "./user-browser.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ace-user-browser-"));
  let service: UserBrowserService | undefined;
  const f = await fixture({}, (store, home) => {
    service = new UserBrowserService({
      dataDir: home,
      platform: "darwin",
      home: root,
      env: {},
      node: process.execPath,
      devices: store.devices,
      now: () => 1,
      clock: {
        now: () => performance.now(),
        set: (delay, work) => {
          const timer = setTimeout(work, delay);
          return () => clearTimeout(timer);
        },
      },
      extraHostDirs: [join(root, "profile/NativeMessagingHosts")],
    });
    return { userBrowser: service };
  });
  cleanups.push(async () => {
    service?.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  });
  const admin = await f.connect();
  expect(await admin.next()).toMatchObject({ type: "welcome" });
  const settings = async (operation: "status" | "install" | "revoke" | "stop") => {
    admin.send({ type: "user_browser.settings", requestId: operation, operation });
    const result = UserBrowserSettingsResult.parse(await admin.next()).result;
    if (result.kind !== "status") throw new Error(result.message);
    return result.status;
  };
  return { ...f, root, settings };
}

/** A raw socket like the native host's: hello with a device token, then anything. */
async function hostSocket(url: string, deviceId: string, token: string) {
  const socket = new WebSocket(url);
  cleanups.push(async () => socket.terminate());
  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId, token }));
  const next = async (type: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const index = messages.findIndex(
        (message) => z.object({ type: z.literal(type) }).safeParse(message).success,
      );
      if (index !== -1) return messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No ${type} message`);
  };
  return { socket, next };
}
const register = {
  type: "user_browser.register",
  requestId: "register",
  version: 1,
  browser: {
    family: "chrome",
    version: "155.0",
    profileId: "profile-1",
    extensionVersion: "0.1.0",
  },
};

it("install mints a local credential that can register a browser and nothing else, and revoke ends it", async () => {
  const f = await setup();
  const installed = await f.settings("install");
  expect(installed.extensionPath).toBe(join(f.home, "user-browser/extension"));
  expect(installed.installed.map((host) => host.browser)).toEqual(["Custom"]);
  expect(
    JSON.parse(await readFile(join(installed.extensionPath ?? "", "manifest.json"), "utf8")),
  ).toMatchObject({ manifest_version: 3, permissions: expect.arrayContaining(["debugger"]) });
  expect((await stat(hostCredentialPath(f.home))).mode & 0o077).toBe(0);
  const credential = DeviceCredential.parse(
    JSON.parse(await readFile(hostCredentialPath(f.home), "utf8")),
  );
  const host = await hostSocket(f.server.url, credential.device.id, credential.token);
  await host.next("welcome");
  // The host's credential carries no admin authority: Settings and storage are refused.
  host.socket.send(
    JSON.stringify({ type: "user_browser.settings", requestId: "x", operation: "revoke" }),
  );
  expect(await host.next("user_browser.settings.result")).toMatchObject({
    result: { kind: "error", code: "forbidden" },
  });
  host.socket.send(
    JSON.stringify({ type: "storage.request", requestId: "s", operation: { op: "storage.usage" } }),
  );
  expect(await host.next("storage.result")).toMatchObject({
    result: { kind: "error", code: "forbidden" },
  });
  host.socket.send(JSON.stringify(register));
  expect(await host.next("user_browser.registered")).toMatchObject({ requestId: "register" });
  expect((await f.settings("status")).connections).toEqual([
    expect.objectContaining({ browser: register.browser, tabs: [] }),
  ]);
  const closed = once(host.socket, "close");
  const revoked = await f.settings("revoke");
  await closed;
  expect(revoked.connections).toEqual([]);
  expect(revoked.installed).toEqual([]);
  await expect(stat(hostCredentialPath(f.home))).rejects.toThrow();
  // The revoked token no longer opens a socket at all.
  const again = await hostSocket(f.server.url, credential.device.id, credential.token);
  expect(await again.next("error")).toMatchObject({ code: "unauthorized" });
});

it("a socket without a Use my Chrome credential cannot register a browser, even the host's own", async () => {
  const f = await setup();
  await f.settings("install");
  const owner = await hostSocket(f.server.url, "device", "a".repeat(64));
  await owner.next("welcome");
  const closed = once(owner.socket, "close");
  owner.socket.send(JSON.stringify(register));
  expect(await owner.next("error")).toMatchObject({ code: "user_browser_denied" });
  await closed;
  expect((await f.settings("status")).connections).toEqual([]);
});
