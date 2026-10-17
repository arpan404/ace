import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { UserChromeHub, type UserChromeLink } from "@ace/browser";
import { UserBrowserRegister } from "@ace/protocol";
import { launchTestChrome } from "./chrome-pipe-test-support.ts";
import { extensionId } from "./extension-id.ts";
import { writeExtension } from "./extension-files.ts";
import { extensionDir, hostCredentialPath } from "./host-files.ts";
import { installNativeHost } from "./install.ts";

type Cleanups = (() => Promise<void>)[];
const token = "c".repeat(64);

export const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** The daemon's socket edge: hello with the host credential, then a browser link on the hub. */
async function daemonSocket(hub: UserChromeHub, cleanups: Cleanups) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    let link: UserChromeLink | undefined;
    let welcomed = false;
    socket.on("message", (data) => {
      const message = z.looseObject({ type: z.string() }).parse(JSON.parse(data.toString()));
      if (!welcomed) {
        welcomed = message.token === token;
        if (welcomed) socket.send(JSON.stringify({ type: "welcome" }));
        else socket.close(4001, "unauthorized");
        return;
      }
      if (message.type === "user_browser.register") {
        link = hub.register(UserBrowserRegister.parse(message).browser, {
          send: (outgoing) => {
            socket.send(JSON.stringify(outgoing));
            return true;
          },
          close: () => socket.close(),
        });
        socket.send(
          JSON.stringify({
            type: "user_browser.registered",
            requestId: message.requestId,
            connectionId: link.connectionId,
          }),
        );
      } else link?.handle(message);
    });
    socket.on("close", () => link?.close("Your browser disconnected"));
  });
  cleanups.push(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * The person's browser with ace for Chrome loaded unpacked and the real native host registered
 * under its profile, connected to a daemon-side hub.
 */
export async function connectedBrowser(chromePath: string, cleanups: Cleanups) {
  const root = await mkdtemp(join(tmpdir(), "ace-my-chrome-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "ace");
  const userDataDir = join(root, "chrome");
  await mkdir(dataDir, { recursive: true });
  const hub = new UserChromeHub({
    now: Date.now,
    clock: {
      now: () => performance.now(),
      set: (delay, work) => {
        const timer = setTimeout(work, delay);
        return () => clearTimeout(timer);
      },
    },
  });
  cleanups.push(async () => hub.closeAll("test finished"));
  await writeFile(join(dataDir, "daemon-endpoint"), await daemonSocket(hub, cleanups));
  await mkdir(join(dataDir, "user-browser"), { recursive: true });
  await writeFile(
    hostCredentialPath(dataDir),
    JSON.stringify({
      device: {
        id: "host-device",
        name: "ace for Chrome",
        scopes: ["user-browser"],
        createdAt: 1,
        lastSeenAt: 1,
        revokedAt: null,
      },
      token,
    }),
  );
  await writeExtension(extensionDir(dataDir));
  await installNativeHost({
    platform: process.platform,
    home: root,
    dataDir,
    node: process.execPath,
    // A browser started with --user-data-dir reads hosts only from its own profile.
    extraDirs: [join(userDataDir, "NativeMessagingHosts")],
  });
  const chrome = await launchTestChrome(chromePath, userDataDir);
  cleanups.push(() => chrome.close());
  const loaded = z
    .object({ id: z.string() })
    .parse(await chrome.send("Extensions.loadUnpacked", { path: extensionDir(dataDir) }));
  expect(loaded.id).toBe(extensionId);
  await until(() => hub.preferred() !== undefined, "the extension to register through its host");
  // The person's view of the extension: its popup page, which talks to the service worker.
  const popup = z.object({ targetId: z.string() }).parse(
    await chrome.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/popup.html`,
    }),
  ).targetId;
  const asPerson = (expression: string) => chrome.evaluate(popup, expression);
  return { hub, chrome, asPerson, root };
}
