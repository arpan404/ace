import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ThreadId, type CommandPayload } from "@ace/protocol";
import { ready, setup, when } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const send = (text: string): CommandPayload => ({
  type: "thread.send",
  // The daemon refuses a send to a thread it doesn't have: the send fails and stays kept.
  threadId: ThreadId.parse("missing-thread"),
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

test("an edit whose save fails keeps the original words, on disk and on screen", async () => {
  const { h, client, id, disk } = await failedSend();
  const kept = await readFile(join(h.directory, "outbox.json"), "utf8");
  expect(kept).toContain("Ship the release notes");
  disk.broken = true;
  await expect(client.editFailedSend(id, send("Ship it today"))).rejects.toMatchObject({
    code: "storage",
  });
  expect(words(client.pendingSend(id)?.payload)).toBe("Ship the release notes");
  expect(await readFile(join(h.directory, "outbox.json"), "utf8")).toBe(kept);
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
