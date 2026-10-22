import { expect, it } from "vitest";
import { definition, harness, scheduled } from "./service-test-support.ts";

function revisionOf(h: ReturnType<typeof harness>, id = "triage"): number | undefined {
  const entry = h.service.handle({ type: "automation.list", requestId: "list-revision" });
  return entry.schedules?.find((schedule) => schedule.id === id)?.revision;
}

it("create-only puts fail while the id is live and succeed after removal", () => {
  const h = harness();
  h.service.put(definition());
  expect(() => h.service.put(definition({ title: "Stale recreate" }), null)).toThrow(
    "already exists",
  );
  expect(
    h.service.handle({
      type: "automation.put",
      requestId: "create-only-live",
      automation: definition({ title: "Wire stale" }),
      expectedRevision: null,
    }),
  ).toMatchObject({ ok: false, error: "Automation already exists" });
  h.service.remove("triage");
  expect(h.service.inbox().runs).toEqual([]);
  h.service.put(definition({ title: "Recreated" }), null);
  expect(h.service.list()).toMatchObject([{ title: "Recreated" }]);
});

it("a stale revision cannot resurrect a removed id, while blind writes can", () => {
  const h = harness();
  h.service.put(definition());
  const first = h.store.revision("triage");
  expect(first).toBe(1);
  h.service.remove("triage");
  expect(h.store.revision("triage")).toBe(2);
  expect(() => h.service.put(definition(), 1)).toThrow("Automation is missing");
  expect(
    h.service.handle({
      type: "automation.put",
      requestId: "stale-resurrect",
      automation: definition(),
      expectedRevision: 1,
    }),
  ).toMatchObject({ ok: false, error: "Automation is missing" });
  h.service.put(definition({ title: "Fresh" }));
  expect(h.store.revision("triage")).toBe(3);
  expect(h.service.list()).toMatchObject([{ title: "Fresh" }]);
});

it("matching revisions update and bump, stale revisions fail without changing state", () => {
  const h = harness();
  h.service.put(definition());
  h.service.put(definition({ title: "Second" }), 1);
  expect(h.store.revision("triage")).toBe(2);
  expect(h.service.list()).toMatchObject([{ title: "Second" }]);
  expect(() => h.service.put(definition({ title: "Stale" }), 1)).toThrow("revision conflict");
  expect(h.service.list()).toMatchObject([{ title: "Second" }]);
  expect(
    h.service.handle({
      type: "automation.put",
      requestId: "wire-bump",
      automation: definition({ title: "Third" }),
      expectedRevision: 2,
    }),
  ).toMatchObject({ ok: true });
  expect(h.store.revision("triage")).toBe(3);
});

it("identical puts with a matching revision stay idempotent without bumping", () => {
  const h = harness();
  const auto = scheduled("run_once", 10_000);
  h.random = 0.5;
  h.service.put(auto);
  const before = h.store.revision("triage");
  h.random = 0.9;
  h.service.put(auto, before);
  expect(h.store.revision("triage")).toBe(before);
  expect(
    h.service.handle({
      type: "automation.put",
      requestId: "identical-wire",
      automation: auto,
      expectedRevision: before ?? undefined,
    }),
  ).toMatchObject({ ok: true });
  expect(h.store.revision("triage")).toBe(before);
});

it("setEnabled flips the stored definition and honors CAS without stale overwrites", async () => {
  const h = harness();
  h.service.put(definition({ title: "Original" }));
  h.service.put(definition({ title: "Renamed" }), 1);
  expect(() => h.service.setEnabled("triage", false, 1)).toThrow("revision conflict");
  expect(h.service.list()).toMatchObject([{ title: "Renamed", enabled: true }]);
  h.service.setEnabled("triage", false, 2);
  expect(h.service.list()).toMatchObject([{ title: "Renamed", enabled: false }]);
  expect(
    h.service.handle({
      type: "automation.setEnabled",
      requestId: "enable-wire",
      id: "triage",
      enabled: true,
      expectedRevision: 3,
    }),
  ).toMatchObject({ ok: true });
  expect(h.service.list()).toMatchObject([{ title: "Renamed", enabled: true }]);
  expect(
    h.service.handle({
      type: "automation.setEnabled",
      requestId: "missing",
      id: "absent",
      enabled: true,
    }),
  ).toMatchObject({ ok: false });
  await h.service.settled();
});

it("revisions survive restart and removals preserve run history", async () => {
  const h = harness();
  h.service.put(definition());
  h.service.trigger("triage", { key: "before-remove", variables: { subject: "issues" } });
  await h.finish();
  const before = h.store.revision("triage");
  h.restart();
  expect(h.store.revision("triage")).toBe(before);
  expect(revisionOf(h)).toBe(before);
  h.service.remove("triage", before);
  expect(h.store.revision("triage")).toBe((before ?? 0) + 1);
  h.restart();
  expect(h.store.revision("triage")).toBe((before ?? 0) + 1);
  expect(h.service.inbox().runs).toHaveLength(1);
  expect(() => h.service.put(definition(), before)).toThrow("Automation is missing");
  h.service.put(definition({ title: "After history" }));
  expect(h.service.inbox().runs).toHaveLength(1);
  await h.service.settled();
});

it("list schedules expose the durable revision for CAS clients", () => {
  const h = harness();
  h.service.put(definition());
  const listed = h.service.handle({ type: "automation.list", requestId: "revisions" });
  expect(listed.schedules).toMatchObject([{ id: "triage", revision: 1 }]);
  h.service.setEnabled("triage", false);
  expect(
    h.service.handle({ type: "automation.list", requestId: "revisions-2" }).schedules,
  ).toMatchObject([{ id: "triage", revision: 2 }]);
});
