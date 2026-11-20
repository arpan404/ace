import { afterEach, expect, it } from "vitest";
import type { Notification } from "@ace/protocol";
import { setup } from "./notify.test-helper.ts";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const notice = (threadId: Notification["threadId"]): Notification => ({
  id: "spade:event:c1:7",
  threadId,
  title: "Booker",
  status: "spade",
  message: "Asks: Window or aisle?",
  backgroundCount: 0,
  actions: [],
  spade: { agent: "a1", conversation: "c1", request: "q2", category: "needs_you" },
});

it("a Spade notice reaches the desktop once, however often it is handed in, and never the phone", async () => {
  const f = setup("accepted");
  fixtures.push(f);
  f.service.notify(notice(f.threadId));
  f.service.notify(notice(f.threadId));
  await f.flush();
  expect(f.deliveries.map((d) => [d.device.id, d.notification.id])).toEqual([
    [f.desktop, "spade:event:c1:7"],
  ]);
  expect(f.deliveries[0]?.notification.spade).toEqual({
    agent: "a1",
    conversation: "c1",
    request: "q2",
    category: "needs_you",
  });
});
