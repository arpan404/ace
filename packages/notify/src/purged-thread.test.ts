import { HostId, ThreadId } from "@ace/protocol";
import { expect, it } from "vitest";
import { setup } from "./notify.test-helper.ts";

it("an event for a thread whose creation was purged from the log is passed over, and replay goes on", async () => {
  const f = setup();
  try {
    // Purging a thread removes its whole event log, its creation too; a write that reached the
    // thread after that leaves an event no notification thread was ever made for.
    const purged = ThreadId.parse("purged-thread");
    expect(() =>
      f.append(
        [
          {
            type: "thread.updated",
            delegatedFrom: { hostId: HostId.parse("host"), threadId: ThreadId.parse("origin") },
          },
        ],
        purged,
      ),
    ).not.toThrow();
    const cursor = f.service.cursor();
    // Events after it still arrive: the live thread's turn ends and its person is told.
    f.start();
    f.end();
    expect(f.service.cursor()).toBeGreaterThan(cursor);
    await f.flush();
    expect(f.deliveries.map(({ notification }) => notification.threadId)).toContain(f.threadId);
  } finally {
    await f.close();
  }
});
