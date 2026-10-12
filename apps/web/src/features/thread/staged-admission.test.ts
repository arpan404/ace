import { beforeEach, expect, test, vi } from "vitest";
import { Client } from "@ace/client";
import { DeviceId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { memoryStorage } from "@/boot/client.ts";

function harness() {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
  const daemon = new FakeDaemon({ clock: () => 1000 });
  let id = 0;
  const client = new Client({
    deviceId: DeviceId.parse("test-device"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: memoryStorage(),
    scheduler: {
      set(delay, callback) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `send-${++id}`,
  });
  return { client, storage };
}
import { sendMessage } from "./composer/send-message.ts";
import {
  reloadPage,
  resetStaged,
  stagedSends,
  sendWhenUploaded,
  stage,
  canRetry,
  retryStaged,
  interrupted,
} from "./composer/staged-sends.ts";
import type { Draft } from "./composer/draft.ts";

beforeEach(() => resetStaged());

function uploading(text: string): Draft {
  return {
    text,
    mentions: [],
    attachments: [],
    opposite: false,
    files: {
      local: [{ name: "notes.txt", mimeType: "text/plain", bytes: 4 }],
      uploading: 1,
      settled: new Promise(() => {}),
      outcomes: new Promise(() => {}),
      files: [new File(["note"], "notes.txt")],
      release() {},
    },
  };
}

test("a full device refuses another upload-held message without losing accepted drafts", async () => {
  const app = harness();
  await app.client.start();
  const send = (index: number) =>
    sendMessage({
      client: app.client,
      storage: app.storage,
      threadId: index % 2 ? "thread-a" : "thread-b",
      commandId: `held-${index}`,
      draft: uploading(`Message ${index}`),
      delivery: undefined,
      options: undefined,
      notify() {},
    });
  for (let index = 0; index < 32; index++) expect(await send(index)).toBe(true);
  expect(await send(32)).toBe(false);
  reloadPage();
  const retained = stagedSends(app.storage).get();
  expect(retained).toHaveLength(32);
  expect(retained.find((entry) => entry.commandId === "held-0")?.text).toBe("Message 0");
  await sendWhenUploaded(app.client, "held-0", Promise.resolve([{ error: "offline" }]));
  expect(
    stagedSends(app.storage)
      .get()
      .find((entry) => entry.commandId === "held-0")?.failed,
  ).toContain("offline");
  await app.client.close();
});

test("a rejected staged write refuses the handoff and a later retry survives reload", async () => {
  const app = harness();
  let fail = true;
  const storage = {
    get length() {
      return app.storage.length;
    },
    key: app.storage.key,
    removeItem: app.storage.removeItem,
    getItem: app.storage.getItem,
    setItem: (key: string, value: string) => {
      if (fail) throw new Error("quota");
      app.storage.setItem(key, value);
    },
  };
  const notices: string[] = [];
  const request = {
    client: app.client,
    storage,
    threadId: "thread-a",
    commandId: "durable",
    draft: uploading("Keep my draft"),
    delivery: undefined,
    options: undefined,
    notify: (title: string) => {
      notices.push(title);
    },
  };
  expect(await sendMessage(request)).toBe(false);
  expect(notices).toContain("Message not sent");
  expect(stagedSends(storage).get()).toEqual([]);
  fail = false;
  expect(await sendMessage(request)).toBe(true);
  reloadPage();
  expect(
    stagedSends(storage)
      .get()
      .map((send) => send.text),
  ).toEqual(["Keep my draft"]);
  await app.client.close();
});

const makeStaged = (commandId: string, text: string) => ({
  commandId,
  threadId: "thread-a",
  text,
  mentions: [],
  attachments: [{ name: "notes.txt", mimeType: "text/plain", bytes: 4 }],
});

test("two initialized tabs retain both uploads and one tab's removal cannot erase the other's draft", async () => {
  localStorage.clear();
  const app = harness();
  await app.client.start();
  vi.resetModules();
  const first = await import("./composer/staged-sends.ts");
  first.stagedSends(localStorage);
  vi.resetModules();
  const second = await import("./composer/staged-sends.ts");
  second.stagedSends(localStorage);
  expect(first.stage(makeStaged("alpha", "Alpha"), { files: [], previews: [] })).toBe(true);
  expect(second.stage(makeStaged("beta", "Beta"), { files: [], previews: [] })).toBe(true);
  // Neither page has received a storage event. A reload reads only durable records.
  first.reloadPage();
  expect(
    first
      .stagedSends(localStorage)
      .get()
      .map((send) => send.text)
      .toSorted(),
  ).toEqual(["Alpha", "Beta"]);
  expect(
    await first.sendWhenUploaded(
      app.client,
      "alpha",
      Promise.resolve([{ sha256: "a".repeat(64) }]),
    ),
  ).toBe(true);
  expect(second.stage(makeStaged("gamma", "Gamma"), { files: [], previews: [] })).toBe(true);
  expect(
    await second.sendWhenUploaded(
      app.client,
      "beta",
      Promise.resolve([{ sha256: "b".repeat(64) }]),
    ),
  ).toBe(true);
  expect(
    app.client
      .pendingSends()
      .getSnapshot()
      .map((send) => send.payload.input),
  ).toEqual([[{ type: "text", text: "Alpha" }], [{ type: "text", text: "Beta" }]]);
  first.reloadPage();
  expect(
    first
      .stagedSends(localStorage)
      .get()
      .map((send) => send.text),
  ).toEqual(["Gamma"]);
  first.reloadPage();
  second.reloadPage();
  localStorage.clear();
  await app.client.close();
});

async function unavailableUpload(): Promise<never> {
  throw new Error("The original File is no longer available");
}

test("completion write failures preserve the durable original and completed hashes for retry", async () => {
  const app = harness();
  let full = false;
  const storage = {
    get length() {
      return app.storage.length;
    },
    key: app.storage.key,
    removeItem: app.storage.removeItem,
    getItem: app.storage.getItem,
    setItem(key: string, value: string) {
      if (full) throw new Error("quota");
      app.storage.setItem(key, value);
    },
  };
  const sends = stagedSends(storage);
  expect(
    stage(makeStaged("completed", "Keep the completed upload"), { files: [], previews: [] }),
  ).toBe(true);
  const original = app.storage.getItem("ace.sends.staged\0completed");
  full = true;
  expect(
    await sendWhenUploaded(app.client, "completed", Promise.resolve([{ sha256: "c".repeat(64) }])),
  ).toBe(false);
  const failed = sends.get().find((send) => send.commandId === "completed");
  expect(failed?.failed).toContain("This device couldn't save the upload results");
  if (!failed) throw new Error("accepted message disappeared");
  expect(canRetry(failed)).toBe(true);
  expect(app.storage.getItem("ace.sends.staged\0completed")).toBe(original);

  // Completion outcomes remain usable through subsequent refreshes and storage refusals.
  expect(await retryStaged(app.client, "completed", unavailableUpload)).toBe(false);
  expect(sends.get().find((send) => send.commandId === "completed")?.failed).toContain(
    "couldn't save",
  );
  full = false;
  expect(await retryStaged(app.client, "completed", unavailableUpload)).toBe(true);
  const sent = app.client
    .pendingSends()
    .getSnapshot()
    .find((send) => send.commandId === "completed");
  expect(sent?.payload.type === "thread.send" && sent.payload.context?.attachments).toEqual([
    { sha256: "c".repeat(64) },
  ]);
  reloadPage();
  expect(stagedSends(storage).get()).toEqual([]);
  await app.client.close();
});

test("closing after a completion write refusal leaves the original message available to edit", async () => {
  const app = harness();
  let full = false;
  const storage = {
    get length() {
      return app.storage.length;
    },
    key: app.storage.key,
    removeItem: app.storage.removeItem,
    getItem: app.storage.getItem,
    setItem(key: string, value: string) {
      if (full) throw new Error("quota");
      app.storage.setItem(key, value);
    },
  };
  stagedSends(storage);
  expect(stage(makeStaged("reload", "Keep this original"), { files: [], previews: [] })).toBe(true);
  full = true;
  expect(
    await sendWhenUploaded(app.client, "reload", Promise.resolve([{ error: "disconnected" }])),
  ).toBe(false);
  expect(stagedSends(storage).get()[0]?.failed).toContain("disconnected");
  reloadPage();
  const retained = stagedSends(storage).get()[0];
  expect(retained?.text).toBe("Keep this original");
  if (!retained) throw new Error("accepted message disappeared");
  expect(canRetry(retained)).toBe(false);
  expect(interrupted(retained)).toContain("The page closed before notes.txt finished uploading");
  await app.client.close();
});
