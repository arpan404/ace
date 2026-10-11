import { DeviceId, Event } from "@ace/protocol";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { setup, writeLegacyQueue } from "./notify.test-helper.ts";

it("upgrading an old projection rebuilds eligible links and preserves device policy", async () => {
  const f = setup();
  try {
    f.service.preferences(f.phone, {
      quietHours: { timeZone: "UTC", startMinute: 0, endMinute: 0 },
    });
    f.start();
    f.fact({
      type: "agent.seen",
      agent: "child",
      parent: "root",
      origin: "provider_subagent",
      fidelity: "full",
      native: { provider: "codex", nativeId: "child" },
      cwd: "/repo",
    });
    f.start("user", "child");
    f.fact({
      type: "interaction.opened",
      agent: "child",
      interaction: "child",
      blocking: false,
      request: { kind: "question", questions: [] },
    });
    const events = f.fact({
      type: "interaction.opened",
      agent: "root",
      interaction: "root",
      blocking: true,
      request: {
        kind: "approval",
        title: "private",
        options: [{ kind: "allow_once", id: "yes", label: "Allow" }],
      },
    });
    const expected = events.find((event) => event.payload.type === "interaction.opened");
    if (expected?.payload.type !== "interaction.opened") throw new Error("Missing approval");
    await f.service.close();
    // Real on-disk predecessor layout: no eligibility projection or schema version.
    const legacy = new DatabaseSync(f.path);
    legacy.exec("DROP TABLE interaction_owners; DROP TABLE agent_status; PRAGMA user_version=0;");
    legacy.close();
    await f.reopen();
    expect(f.service.cursor()).toBe(0);
    f.service.ingest(f.history);
    await f.flush();
    expect(
      f.deliveries.map((d) => ({ device: d.device.id, interaction: d.notification.interactionId })),
    ).toEqual([{ device: f.desktop, interaction: expected.payload.interaction.id }]);
    expect(f.service.cursor()).toBe(f.history.at(-1)?.seq);
  } finally {
    await f.close();
  }
});

it("an older device table can accept new browser identities after migration without losing push preferences", async () => {
  const f = setup();
  try {
    f.service.preferences(f.phone, { includePreview: true });
    await f.service.close();
    const legacy = new DatabaseSync(f.path);
    legacy.exec(`DROP INDEX devices_seen; ALTER TABLE devices DROP COLUMN last_seen;`);
    legacy.close();
    await f.reopen();
    expect(f.service.getPreferences(f.phone)).toMatchObject({ includePreview: true });
    f.service.connectDevice(DeviceId.parse("new-browser"));
    f.start();
    f.end();
    await f.flush();
    expect(f.deliveries.some(({ device }) => device.id === "new-browser")).toBe(true);
    expect(f.deliveries.find(({ device }) => device.id === f.phone)?.notification.preview).toBe(
      "sensitive preview",
    );
  } finally {
    await f.close();
  }
});

it("upgrading a version-2 projection replays skipped deletion and preserves device policy", async () => {
  const f = setup("retry");
  try {
    f.service.preferences(f.phone, { includePreview: true });
    f.start();
    f.end();
    await f.flush();
    const deletion = Event.parse({
      seq: f.service.cursor() + 1,
      id: "skipped-deletion",
      threadId: f.threadId,
      at: 6000,
      payload: { type: "thread.client.updated", changes: { deletedAt: 6000 } },
    });
    f.history.push(deletion);
    await f.service.close();
    writeLegacyQueue(f.path, 2);
    const legacy = new DatabaseSync(f.path);
    try {
      // Version 2 advanced past deletion without projecting it or cancelling its jobs.
      legacy.exec(`ALTER TABLE devices DROP COLUMN expired;
        UPDATE threads SET body=json_remove(body,'$.deleted');`);
      legacy.prepare("UPDATE cursor SET seq=? WHERE id=1").run(deletion.seq);
    } finally {
      legacy.close();
    }
    await f.reopen();
    expect(f.service.cursor()).toBe(0);
    expect(f.service.getPreferences(f.phone)).toMatchObject({ includePreview: true });
    f.service.ingest(f.history);
    f.setOutcome("accepted");
    f.service.notify({
      id: "late-deleted-notice",
      threadId: f.threadId,
      title: "Late notice",
      status: "agent_says",
      backgroundCount: 0,
      actions: [],
    });
    await f.flush();
    expect(f.service.cursor()).toBe(deletion.seq);
    expect(f.deliveries).toHaveLength(2);
    await f.reopen();
    await f.flush();
    expect(f.deliveries).toHaveLength(2);
  } finally {
    await f.close();
  }
});

it("upgrading a version-3 queue preserves notification identities and retry backoff", async () => {
  const f = setup("retry");
  try {
    f.start();
    f.end();
    await f.flush();
    const ids = f.deliveries.map(({ notification }) => notification.id);
    const cursor = f.service.cursor();
    await f.service.close();
    writeLegacyQueue(f.path, 3);
    await f.reopen();
    expect(f.service.cursor()).toBe(cursor);
    f.setTime(6999);
    await f.service.drain();
    expect(f.deliveries).toHaveLength(2);
    f.setTime(7000);
    await f.service.drain();
    expect(f.deliveries.slice(2).map(({ notification }) => notification.id)).toEqual(ids);
    f.setOutcome("accepted");
    f.setTime(8999);
    await f.service.drain();
    expect(f.deliveries).toHaveLength(4);
    f.setTime(9000);
    await f.service.drain();
    expect(f.deliveries.slice(4).map(({ notification }) => notification.id)).toEqual(ids);
  } finally {
    await f.close();
  }
});
