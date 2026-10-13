import { ThreadId, type CommandPayload } from "@ace/protocol";
import { beforeEach, expect, test } from "vitest";
import { createBrowserClient, localOutbox } from "./client.ts";

/*
 * The outbox of a page without workers, in localStorage (review of #126): two tabs saving
 * offline sends keep both. (Work an older build saved without a verified daemon identity is
 * covered in host-binding.test.ts.)
 */

const key = "ace.outbox.ws://daemon.device";

beforeEach(() => localStorage.clear());

function offlineTab() {
  return createBrowserClient({
    deviceId: "device",
    transport: () => {
      throw new Error("offline");
    },
    credential: async () => "token",
    storage: localOutbox(key),
  });
}

const send = (text: string): CommandPayload => ({
  type: "thread.send",
  threadId: ThreadId.parse("thread"),
  input: [{ type: "text", text }],
});

async function waitingAfterReload(): Promise<string[]> {
  const tab = offlineTab();
  await tab.start();
  const waiting = tab
    .pendingSends()
    .getSnapshot()
    .map((entry) => entry.commandId);
  await tab.close();
  return waiting.toSorted();
}

test("two tabs saving offline sends both keep them across a reload", async () => {
  // The outbox is pinned to the daemon these tabs verified before the network went away.
  localStorage.setItem(`${key}.host`, "office");
  const a = offlineTab();
  const b = offlineTab();
  await Promise.all([a.start(), b.start()]);
  await Promise.all([a.enqueue(send("from a"), "send-a"), b.enqueue(send("from b"), "send-b")]);
  await Promise.all([a.close(), b.close()]);
  expect(await waitingAfterReload()).toEqual(["send-a", "send-b"]);
});
