import { beforeEach, expect, test, vi } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, ThreadId } from "@ace/protocol";
import { FakeDaemon, fakeTransport, facts } from "@ace/fake-daemon";
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
  return { client, storage, daemon };
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
  isInterrupted,
  removeStagedUpload,
} from "./composer/staged-sends.ts";
import type { Draft } from "./composer/draft.ts";
import { daemonContextSource } from "./sources/context-source.ts";

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
  const original = retained.find((entry) => entry.commandId === "held-0");
  if (!original) throw new Error("Missing accepted message");
  expect(isInterrupted(original, 1000)).toBe(true);
  expect(
    await sendWhenUploaded(app.client, "held-0", Promise.resolve([{ error: "offline" }])),
  ).toBe(false);
  expect(app.client.pendingSends().getSnapshot()).toEqual([]);
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

test("two tabs removing the same interrupted submission release its successor only once", async () => {
  localStorage.clear();
  const app = harness();
  app.daemon.createThread({
    id: "thread-a",
    workspaceId: "ace",
    title: "Remove interrupted upload",
    provider: "codex",
  });
  app.daemon.apply("thread-a", [facts.rootAgent("codex"), facts.turn("root")]);
  await app.client.start();
  vi.resetModules();
  const first = await import("./composer/staged-sends.ts");
  first.stagedSends(localStorage);
  expect(
    first.stage(makeStaged("alpha", "Alpha"), { files: [], previews: [] }, { now: () => 1000 }),
  ).toBe(true);
  expect(
    first.stage({ ...makeStaged("beta", "Beta"), attachments: [] }, { files: [], previews: [] }),
  ).toBe(true);
  first.reloadPage();
  first.stagedSends(localStorage);
  vi.resetModules();
  const second = await import("./composer/staged-sends.ts");
  second.stagedSends(localStorage);
  expect(
    await Promise.all([
      first.removeStagedUpload(app.client, "alpha", localStorage, { now: () => 1000 }),
      second.removeStagedUpload(app.client, "alpha", localStorage, { now: () => 1000 }),
    ]),
  ).toEqual([true, true]);
  expect(await second.removeStagedUpload(app.client, "alpha", localStorage)).toBe(true);
  expect(
    app.client
      .pendingSends()
      .getSnapshot()
      .map((send) => send.payload.input),
  ).toEqual([[{ type: "text", text: "Beta" }]]);
  expect(
    await first.sendWhenUploaded(
      app.client,
      "alpha",
      Promise.resolve([{ sha256: "a".repeat(64) }]),
    ),
  ).toBe(false);
  expect(app.client.pendingSends().getSnapshot()).toHaveLength(1);
  const { queue } = await app.client.request({
    type: "queue.get",
    threadId: ThreadId.parse("thread-a"),
  });
  expect(queue.messages.map((send) => send.input)).toEqual([[{ type: "text", text: "Beta" }]]);
  first.reloadPage();
  expect(first.stagedSends(localStorage).get()).toEqual([]);
  second.reloadPage();
  localStorage.clear();
  await app.client.close();
});

async function unavailableUpload(): Promise<never> {
  throw new Error("The original File is no longer available");
}

test("completion write failures preserve the durable original and completed hashes for retry", async () => {
  const app = harness();
  // The outbox takes sends once the client has loaded it.
  await app.client.start();
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

test("closing after a completion write refusal keeps the original message interrupted", async () => {
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
  expect(isInterrupted(retained, 1000)).toBe(true);
  await app.client.close();
});

test("removing an unfinished upload cleans its late attachment while keeping its successor's file", async () => {
  const app = harness();
  const thread = { id: "thread-a", workspaceId: "ace", title: "Remove interrupted upload" };
  app.daemon.createThread({ ...thread, provider: "codex" });
  app.daemon.apply(thread.id, [facts.rootAgent("codex"), facts.turn("root")]);
  await app.client.start();
  const context = daemonContextSource(app.client);
  const alpha = await context.upload(
    thread,
    new File(["alpha"], "alpha.txt", { type: "text/plain" }),
    () => {},
  );
  const beta = await context.upload(
    thread,
    new File(["beta"], "beta.txt", { type: "text/plain" }),
    () => {},
  );
  stagedSends(app.storage);
  expect(
    stage(
      { ...makeStaged("alpha", "Alpha"), uploadInterrupted: true },
      { files: [], previews: [] },
    ),
  ).toBe(true);
  const outcomes = Promise.withResolvers<readonly { sha256: string }[]>();
  const sending = sendWhenUploaded(app.client, "alpha", outcomes.promise, app.storage);
  expect(
    stage({ ...makeStaged("beta", "Beta"), attachments: [beta] }, { files: [], previews: [] }),
  ).toBe(true);
  expect(await removeStagedUpload(app.client, "alpha", app.storage)).toBe(true);
  outcomes.resolve([{ sha256: alpha.sha256 }]);
  expect(await sending).toBe(false);
  expect(await removeStagedUpload(app.client, "alpha", app.storage)).toBe(true);
  const { queue } = await app.client.request({
    type: "queue.get",
    threadId: ThreadId.parse(thread.id),
  });
  expect(queue.messages.map((send) => send.input)).toEqual([[{ type: "text", text: "Beta" }]]);
  expect(queue.messages[0]?.context?.attachments).toEqual([{ sha256: beta.sha256 }]);
  expect((await context.list(thread)).map((file) => file.sha256)).toEqual([beta.sha256]);
  await app.client.close();
});
