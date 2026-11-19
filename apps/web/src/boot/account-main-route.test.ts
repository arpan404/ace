// @vitest-environment node
import { createServer } from "node:http";
import { ThreadId, type CommandPayload } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { legacyOutboxError } from "./account-machine-options.ts";
import { browserAccountRoutes } from "./account-main-route.ts";
import { createBrowserClient } from "./client.ts";

/*
 * A desktop window opening its stored account machine (ADR 0111): the window's own storage
 * starts empty and its ace session comes from the app's secure store, through a real local
 * account backend. The relay is out of reach, so the machine's client stays offline and keeps
 * its sends in its outbox.
 */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of closers.splice(0)) await close();
});

const tokenA = "a".repeat(43);
const userA = { id: "user_a", email: "a@example.com", name: "A" };
const hostId = "A".repeat(52);
const deviceId = "device-1234";

function keyValue(initial: Record<string, string> = {}): KeyValueStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

/** The account backend: it knows A's session and gives no grants (the relay is unreachable). */
async function accountBackend() {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (
        request.url === "/v1/account/session" &&
        request.headers.authorization === `Bearer ${tokenA}`
      ) {
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify({ account: userA, expiresAt: Date.now() + 86_400_000 }));
      }
      response.statusCode = 503;
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `127.0.0.1:${address.port}`;
}

let origin = "";
beforeEach(async () => {
  const host = await accountBackend();
  origin = `http://${host}`;
  vi.stubEnv("VITE_ACE_ACCOUNT_URL", origin);
  vi.stubEnv("VITE_ACE_HOSTED_RELAY_URL", `ws://${host}`);
});

const secure = { read: async () => tokenA, write: async () => {} };
const send = (text: string): CommandPayload => ({
  type: "thread.send",
  threadId: ThreadId.parse("thread"),
  input: [{ type: "text", text }],
});

/** Opens the stored machine in a window with `session` storage, and reads what waits to send. */
async function openWindow(session: KeyValueStorage) {
  const routes = browserAccountRoutes({
    storage: keyValue({ "ace.account.deviceId": deviceId }),
    session,
    secure,
  });
  const route = await routes({ origin, hostId, name: "Office Mac" });
  if (!route) throw new Error("No route");
  const client = route.client();
  await client.start();
  return {
    client,
    waiting: () =>
      client
        .pendingSends()
        .getSnapshot()
        .map(({ commandId, state, error }) => ({ commandId, state, error })),
  };
}

test("a desktop window opening its stored account machine keeps queued work under its account", async () => {
  const session = keyValue();
  const first = await openWindow(session);
  await first.client.enqueue(send("Run the tests"), "send-1");
  await first.client.close();

  const reloaded = await openWindow(session);
  expect(reloaded.waiting()).toEqual([
    expect.objectContaining({ commandId: "send-1", state: expect.not.stringMatching("failed") }),
  ]);
  await reloaded.client.close();
});

test("work an older build queued for the machine waits for the person to send again or discard", async () => {
  const legacyKey = `ace.account.outbox:${hostId}`;
  const session = keyValue();
  // An older build's client, offline, with one send queued under the machine alone.
  const older = createBrowserClient({
    deviceId,
    transport: () => {
      throw new Error("offline");
    },
    credential: async () => "grant",
    storage: {
      load: async () => session.getItem(legacyKey),
      save: async (value) => session.setItem(legacyKey, value),
    },
  });
  await older.start();
  await older.enqueue(send("Queued before the update"), "send-old");
  await older.close();

  const opened = await openWindow(session);
  // Nothing says which account queued it, so it is never sent on its own.
  expect(opened.waiting()).toEqual([
    { commandId: "send-old", state: "failed", error: legacyOutboxError },
  ]);
  await opened.client.close();
  expect(session.getItem(legacyKey)).toBeNull();
  const again = await openWindow(session);
  expect(again.waiting()).toEqual([
    { commandId: "send-old", state: "failed", error: legacyOutboxError },
  ]);
  await again.client.close();
});
