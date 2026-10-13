import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, ThreadId } from "@ace/protocol";
import { FakeDaemon, fakeTransport, facts } from "@ace/fake-daemon";
import { memoryStorage } from "@/boot/client.ts";
import { uploadTimeoutMs } from "./composer/upload-interruption.ts";
import { daemonContextSource } from "./sources/context-source.ts";
import type { StagedSend } from "./composer/send-store.ts";

/*
 * Issue #580: independent tabs share one device's held messages through localStorage. Each tab
 * is a fresh copy of the module with its own client on the same daemon.
 */

const threadId = "thread-a";
const sha = (char: string) => char.repeat(64);
const started = 1000;
const clock = (now: number) => ({ now: () => now });

function daemon() {
  const fake = new FakeDaemon({ clock: () => started });
  fake.createThread({ id: threadId, workspaceId: "ace", title: "Cross-tab", provider: "codex" });
  // A turn is running, so sends wait in the daemon's queue where they can be counted.
  fake.apply(threadId, [facts.rootAgent("codex"), facts.turn("root")]);
  return fake;
}

const clients: Client[] = [];
async function openTab(fake: FakeDaemon) {
  vi.resetModules();
  const sends = await import("./composer/staged-sends.ts");
  sends.stagedSends(localStorage);
  let id = 0;
  const client = new Client({
    deviceId: DeviceId.parse(`tab-${clients.length}`),
    transport: () => fakeTransport(fake),
    credential: async () => fake.token,
    storage: memoryStorage(),
    scheduler: {
      set(delay, callback) {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `tab-send-${++id}`,
  });
  clients.push(client);
  await client.start();
  const find = () => sends.stagedSends(localStorage).get()[0];
  return { sends, client, find };
}

const message = (attachments: StagedSend["attachments"]): StagedSend => ({
  commandId: "held",
  threadId,
  text: "Look at this",
  mentions: [],
  attachments,
});
const unfinished = [{ name: "shot.png", mimeType: "image/png", bytes: 4 }];
/** Upload `contents` as shot.png for real, so the daemon accepts a send that carries it. */
async function upload(client: Client, contents: string) {
  const thread = { id: threadId, workspaceId: "ace", title: "Cross-tab" };
  const file = new File([contents], "shot.png", { type: "image/png" });
  const { sha256 } = await daemonContextSource(client).upload(thread, file, () => {});
  return { name: "shot.png", mimeType: "image/png", bytes: file.size, sha256 };
}

const text = [{ type: "text", text: "Look at this" }];
const nothingToUpload = async (): Promise<never> => {
  throw new Error("nothing is left to upload");
};

/** What reached the daemon, once every tab's outbox has drained, and how often it was sent. */
async function delivered(): Promise<{ queued: unknown[]; sends: number }> {
  const [reader] = clients;
  if (!reader) throw new Error("no tab open");
  const sends = clients.flatMap((client) =>
    client
      .pendingSends(threadId)
      .getSnapshot()
      .filter((send) => send.commandId === "held"),
  ).length;
  await vi.waitFor(() =>
    expect(
      clients.every((client) =>
        client
          .pendingSends(threadId)
          .getSnapshot()
          .every((send) => send.state !== "saving" && send.state !== "sent"),
      ),
    ).toBe(true),
  );
  const { queue } = await reader.request({
    type: "queue.get",
    threadId: ThreadId.parse(threadId),
  });
  return { queued: queue.messages.map((entry) => entry.input), sends };
}

const fakeLocks = () => {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name: string, run: () => unknown) {
      const result = (tails.get(name) ?? Promise.resolve()).then(run);
      tails.set(
        name,
        result.catch(() => undefined),
      );
      return result;
    },
  };
};

beforeEach(() => localStorage.clear());
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  Reflect.deleteProperty(navigator, "locks");
  localStorage.clear();
});

test.each(["without Web Locks", "with Web Locks"])(
  "another tab offers nothing while the uploader lives, and recovers as soon as it closes (%s)",
  async (mode) => {
    if (mode === "with Web Locks")
      Object.defineProperty(navigator, "locks", { value: fakeLocks(), configurable: true });
    const fake = daemon();
    const uploader = await openTab(fake);
    expect(
      uploader.sends.stage(message(unfinished), { files: [], previews: [] }, clock(started)),
    ).toBe(true);
    const outcomes = Promise.withResolvers<readonly { sha256: string }[]>();
    const uploading = uploader.sends.sendWhenUploaded(
      uploader.client,
      "held",
      outcomes.promise,
      localStorage,
    );

    const other = await openTab(fake);
    const live = other.find();
    if (!live) throw new Error("held message missing");
    expect(other.sends.isInterrupted(live, started + 1)).toBe(false);
    expect(other.sends.isRecoverable(live, started + 1)).toBe(false);
    const take = vi.fn(() => true);
    expect(await other.sends.editStaged("held", take, clock(started + 1))).toBe(false);
    expect(
      await other.sends.removeStagedUpload(other.client, "held", localStorage, clock(started + 1)),
    ).toBe(true);
    expect(take).not.toHaveBeenCalled();
    expect(other.find()?.text).toBe("Look at this");

    // The uploader's tab closes: its upload is free for others at once, lease or not.
    dispatchEvent(new Event("pagehide"));
    const freed = other.find();
    if (!freed) throw new Error("held message missing");
    expect(other.sends.isInterrupted(freed, started + 1)).toBe(true);
    expect(await other.sends.editStaged("held", take, clock(started + 1))).toBe(true);
    expect(take).toHaveBeenCalledWith(expect.objectContaining({ text: "Look at this" }));
    expect(other.find()).toBeUndefined();

    // The closed page's upload finishing late sends nothing.
    outcomes.resolve([{ sha256: sha("a") }]);
    expect(await uploading).toBe(false);
    expect(await delivered()).toEqual({ queued: [], sends: 0 });
  },
);

test("a crashed uploader's message waits for its lease, and its late upload can't overwrite the recovery", async () => {
  const fake = daemon();
  const uploader = await openTab(fake);
  uploader.sends.stage(message(unfinished), { files: [], previews: [] }, clock(started));
  const outcomes = Promise.withResolvers<readonly { sha256: string }[]>();
  const uploading = uploader.sends.sendWhenUploaded(
    uploader.client,
    "held",
    outcomes.promise,
    localStorage,
  );
  // No pagehide: the page froze or crashed, so only the lease can tell.
  const other = await openTab(fake);
  const expires = started + uploadTimeoutMs;
  const reupload = vi.fn(async () => ({ sha256: sha("b") }));
  expect(await other.sends.retryStaged(other.client, "held", reupload, clock(expires - 1))).toBe(
    false,
  );
  expect(other.find()?.failed).toBeUndefined();

  // The lease is over: this tab claims it. The file's bytes stayed in the dead page.
  expect(await other.sends.retryStaged(other.client, "held", reupload, clock(expires))).toBe(false);
  expect(other.find()?.failed).toBe("shot.png didn't upload: it isn't on this page any more");

  // The old page wakes and its upload completes: it no longer owns the message.
  outcomes.resolve([{ sha256: sha("a") }]);
  expect(await uploading).toBe(false);
  const recovered = other.find();
  expect(recovered?.failed).toBe("shot.png didn't upload: it isn't on this page any more");
  expect(recovered?.attachments[0]?.sha256).toBeUndefined();
  expect(await delivered()).toEqual({ queued: [], sends: 0 });

  // Unfinished attachments stay with the message until someone decides: here, Remove.
  expect(
    await other.sends.removeStagedUpload(other.client, "held", localStorage, clock(expires)),
  ).toBe(true);
  expect(other.find()).toBeUndefined();
  expect(await delivered()).toEqual({ queued: [], sends: 0 });
});

/** A page whose files all reached the daemon, closed before it could send the message. */
async function closedAfterUploading(fake: FakeDaemon) {
  const uploader = await openTab(fake);
  const shot = await upload(uploader.client, "shot");
  uploader.sends.stage(
    { ...message([shot]), preparing: true },
    { files: [], previews: [] },
    clock(started),
  );
  uploader.sends.reloadPage();
}

test("two tabs retrying the same interrupted message deliver it exactly once", async () => {
  const fake = daemon();
  await closedAfterUploading(fake);
  const first = await openTab(fake);
  const second = await openTab(fake);
  const results = await Promise.all([
    first.sends.retryStaged(first.client, "held", nothingToUpload, clock(started + 1)),
    second.sends.retryStaged(second.client, "held", nothingToUpload, clock(started + 1)),
  ]);
  expect(results.toSorted()).toEqual([false, true]);
  expect(await delivered()).toEqual({ queued: [text], sends: 1 });
  expect(first.find()).toBeUndefined();
});

test("Edit in one tab and Retry in another can't both take the same interrupted message", async () => {
  const fake = daemon();
  await closedAfterUploading(fake);
  const editor = await openTab(fake);
  const retrier = await openTab(fake);
  const take = vi.fn(() => true);
  const [edited, sent] = await Promise.all([
    editor.sends.editStaged("held", take, clock(started + 1)),
    retrier.sends.retryStaged(
      retrier.client,
      "held",
      (file) => upload(retrier.client, file.name),
      clock(started + 1),
    ),
  ]);
  expect(edited !== sent).toBe(true);
  expect(take.mock.calls.length).toBe(edited ? 1 : 0);
  expect(await delivered()).toEqual(sent ? { queued: [text], sends: 1 } : { queued: [], sends: 0 });
  expect(editor.find()).toBeUndefined();
});

test("a retry under way fences the stalled first upload and another tab's Remove", async () => {
  const fake = daemon();
  const owner = await openTab(fake);
  const file = new File(["shot"], "shot.png", { type: "image/png" });
  owner.sends.stage(message(unfinished), { files: [file], previews: [] }, clock(started));
  const stalled = Promise.withResolvers<readonly { sha256: string }[]>();
  const firstUpload = owner.sends.sendWhenUploaded(
    owner.client,
    "held",
    stalled.promise,
    localStorage,
  );
  // The first upload outlives its lease; the same page retries with its own copy of the file.
  const expires = started + uploadTimeoutMs;
  const again = Promise.withResolvers<void>();
  const retrying = owner.sends.retryStaged(
    owner.client,
    "held",
    async (copy) => {
      await again.promise;
      return upload(owner.client, await copy.text());
    },
    clock(expires),
  );
  await vi.waitFor(() => expect(owner.find()?.fence).toBe(1));

  const other = await openTab(fake);
  const live = other.find();
  if (!live) throw new Error("held message missing");
  expect(other.sends.isRecoverable(live, expires + 1)).toBe(false);
  expect(
    await other.sends.removeStagedUpload(other.client, "held", localStorage, clock(expires + 1)),
  ).toBe(true);
  expect(other.find()?.text).toBe("Look at this");

  // The stalled first upload lands after the retry took over: it must not settle anything.
  stalled.resolve([{ sha256: sha("a") }]);
  expect(await firstUpload).toBe(false);
  expect(owner.find()?.preparing).toBe(true);

  again.resolve();
  expect(await retrying).toBe(true);
  expect(await delivered()).toEqual({ queued: [text], sends: 1 });
  const { queue } = await owner.client.request({
    type: "queue.get",
    threadId: ThreadId.parse(threadId),
  });
  const retried = await upload(owner.client, "shot");
  expect(queue.messages[0]?.context?.attachments).toEqual([{ sha256: retried.sha256 }]);
});
