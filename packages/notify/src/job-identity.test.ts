import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { z } from "zod";
import { DeviceId, type Notification } from "@ace/protocol";
import { setup } from "./notify.test-helper.ts";

it("queued delivery identities are not reused after emptying the queue, reopening and VACUUM", async () => {
  const f = setup("retry");
  const queuedIds = () => {
    const database = new DatabaseSync(f.path);
    try {
      return z.array(z.number().int()).parse(
        database
          .prepare("SELECT id FROM jobs ORDER BY id")
          .all()
          .map((row) => row.id),
      );
    } finally {
      database.close();
    }
  };
  try {
    const notice: Notification = {
      id: "first-notice",
      threadId: f.threadId,
      title: "Accepted notice",
      status: "agent_says",
      backgroundCount: 0,
      actions: [],
    };
    // Leave accepted notices queued while the transport is temporarily unavailable.
    f.service.notify(notice);
    await f.service.drain();
    const priorIds = queuedIds();
    expect(priorIds).toHaveLength(2);
    f.service.revoke(f.desktop);
    f.service.revoke(f.phone);
    expect(queuedIds()).toEqual([]);
    await f.reopen();
    const database = new DatabaseSync(f.path);
    try {
      database.exec("VACUUM");
    } finally {
      database.close();
    }
    f.service.connectDevice(DeviceId.parse("later-desktop"));
    f.service.connectDevice(DeviceId.parse("later-browser"));
    f.service.notify({ ...notice, id: "later-notice" });
    const laterIds = queuedIds();
    expect(laterIds).toHaveLength(2);
    expect(laterIds.every((id) => !priorIds.includes(id))).toBe(true);
    f.setOutcome("accepted");
    await f.service.drain();
    expect(f.deliveries.slice(2).map(({ notification }) => notification.id)).toEqual([
      "later-notice",
      "later-notice",
    ]);
  } finally {
    await f.close();
  }
});
