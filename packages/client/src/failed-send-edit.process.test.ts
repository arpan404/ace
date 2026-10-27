import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ThreadId, type CommandPayload } from "@ace/protocol";
import type { ClientCore as Client } from "./client-core.ts";
import { retrySend } from "./send-retry.ts";
import { ready, setup, when } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const send = (text: string, threadId = ThreadId.parse("missing-thread")): CommandPayload => ({
  type: "thread.send",
  // The daemon refuses a send to a thread it doesn't have: the send fails and stays kept.
  threadId,
  input: [{ type: "text", text }],
  delivery: "queue",
});
const words = (payload: CommandPayload | undefined) =>
  payload?.type === "thread.send" && payload.input[0]?.type === "text"
    ? payload.input[0].text
    : undefined;

/** A failed send on a disk that can be made to refuse writes, as a crash mid-save leaves it. */
async function failedSend() {
  const h = await setup();
  cleanup = h.cleanup;
  const disk = { broken: false };
  const { client } = h.make({
    storage: {
      load: h.storage.load,
      async save(value) {
        if (disk.broken) throw new Error("disk full");
        await h.storage.save(value);
      },
    },
  });
  await ready(client);
  const id = await client.enqueue(send("Ship the release notes"), "failed-send");
  await when(client.intent(id), (intent) => intent?.state === "failed");
  return { h, client, id, disk };
}

test("editing a failed send changes its words in place, kept across a restart", async () => {
  const { h, client, id } = await failedSend();
  await client.editFailedSend(id, send("Ship the release notes today"));
  expect(words(client.pendingSend(id)?.payload)).toBe("Ship the release notes today");
  expect(client.pendingSend(id)?.state).toBe("failed");
  client.close();
  const next = h.make({ storage: h.storage }).client;
  await ready(next);
  expect(words(next.intent(id).getSnapshot()?.command.payload)).toBe(
    "Ship the release notes today",
  );
});

/** Retry's queue check answered as an empty queue (the test daemon keeps no queue), held by `gate`. */
function retrying(client: Client, gate: Promise<void> = Promise.resolve()) {
  return {
    request: (async () => {
      await gate;
      return { queue: { messages: [], next: null, revision: 0 } };
    }) as unknown as Client["request"],
    command: client.command.bind(client),
    enqueue: client.enqueue.bind(client),
  };
}

test("a crash mid-save of an edit leaves the original words after the restart", async () => {
  const { h, client, id } = await failedSend();
  // This outbox saves by writing a temporary file and renaming it over the old one. The app
  // dies between the two: the new file is written, the rename never happens.
  const killed = { now: false };
  const dying = h.make({
    storage: {
      load: h.storage.load,
      async save(value) {
        if (!killed.now) return h.storage.save(value);
        await writeFile(join(h.directory, "outbox.tmp"), value);
        throw new Error("the app was killed");
      },
    },
  }).client;
  client.close();
  await ready(dying);
  killed.now = true;
  await expect(dying.editFailedSend(id, send("Ship it today"))).rejects.toMatchObject({
    code: "storage",
  });
  expect(words(dying.pendingSend(id)?.payload)).toBe("Ship the release notes");
  dying.close();
  const next = h.make({ storage: h.storage }).client;
  await ready(next);
  expect(words(next.intent(id).getSnapshot()?.command.payload)).toBe("Ship the release notes");
});

test("an edited send that failed to save on this device survives a restart, and Retry sends it", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const disk = { broken: false };
  const storage = {
    load: h.storage.load,
    async save(value: string) {
      if (disk.broken) throw new Error("disk full");
      await h.storage.save(value);
    },
  };
  const first = h.make({ storage }).client;
  await ready(first);
  disk.broken = true;
  const payload = send("Ship the release notes", h.thread.id);
  await expect(first.enqueue(payload, "local-failure")).rejects.toBeDefined();
  expect(first.pendingSend("local-failure")?.state).toBe("failed");
  disk.broken = false;
  await first.editFailedSend("local-failure", send("Ship it today", h.thread.id));
  first.close();
  const second = h.make({ storage: h.storage }).client;
  await ready(second);
  expect(words(second.pendingSend("local-failure")?.payload)).toBe("Ship it today");
  await retrySend(
    retrying(second),
    "local-failure",
    () => second.pendingSend("local-failure")?.payload,
  );
  expect(words(second.intent("local-failure:retry").getSnapshot()?.command.payload)).toBe(
    "Ship it today",
  );
});

test("Retry sends the words an edit saved while it was checking the queue", async () => {
  const { client, id } = await failedSend();
  const { promise: checked, resolve: release } = Promise.withResolvers<void>();
  // The queue check is held until the edit is saved.
  const retry = retrySend(retrying(client, checked), id, () => client.pendingSend(id)?.payload);
  await client.editFailedSend(id, send("Ship it today"));
  release();
  await retry.catch(() => {});
  expect(words(client.intent(`${id}:retry`).getSnapshot()?.command.payload)).toBe("Ship it today");
});

test("only a send that failed can be edited, and only within its own thread", async () => {
  const { client, id } = await failedSend();
  await expect(
    client.editFailedSend(id, {
      type: "thread.send",
      threadId: ThreadId.parse("other"),
      input: [{ type: "text", text: "Elsewhere" }],
      delivery: "queue",
    }),
  ).rejects.toMatchObject({ code: "protocol" });
  await expect(client.editFailedSend("not-kept", send("x"))).rejects.toMatchObject({
    code: "protocol",
  });
});
