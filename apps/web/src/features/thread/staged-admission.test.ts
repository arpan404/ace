import { beforeEach, expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { memoryStorage } from "@/boot/client.ts";

function harness() {
  const data = new Map<string, string>();
  const storage = {
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
import { reloadPage, resetStaged, stagedSends, sendWhenUploaded } from "./composer/staged-sends.ts";
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
  expect(retained.find((send) => send.commandId === "held-0")?.text).toBe("Message 0");
  await sendWhenUploaded(app.client, "held-0", Promise.resolve([{ error: "offline" }]));
  expect(
    stagedSends(app.storage)
      .get()
      .find((send) => send.commandId === "held-0")?.failed,
  ).toContain("offline");
  await app.client.close();
});

test("a rejected staged write refuses the handoff and a later retry survives reload", async () => {
  const app = harness();
  let fail = true;
  const storage = {
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
