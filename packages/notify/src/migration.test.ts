import { DeviceId } from "@ace/protocol";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { setup } from "./notify.test-helper.ts";

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
