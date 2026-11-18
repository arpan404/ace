import { AutomationStore } from "./index.ts";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { harness, definition, scheduled, start } from "./service-test-support.ts";
it("catalog metadata is scoped and follows saves, disables and deletions without loading prompt payloads", () => {
  const h = harness();
  const auto = definition({ prompt: "large prompt ".repeat(10000) });
  h.service.put(auto);
  h.service.put(definition({ id: "other-provider", provider: "claude" }));
  h.service.put(definition({ id: "other-workspace", workspace: "/elsewhere" }));
  h.service.put(definition({ id: "disabled", enabled: false }));
  expect(h.service.catalog(auto.provider, auto.workspace)).toEqual([
    { id: auto.id, title: auto.title },
  ]);
  h.service.put({ ...auto, title: "Renamed" });
  expect(h.service.catalog(auto.provider, auto.workspace)).toEqual([
    { id: auto.id, title: "Renamed" },
  ]);
  h.service.put({ ...auto, enabled: false });
  expect(h.service.catalog(auto.provider, auto.workspace)).toEqual([]);
  h.service.put(auto);
  h.service.remove(auto.id);
  expect(h.service.catalog(auto.provider, auto.workspace)).toEqual([]);
});
it("a reopened catalog reads names without validating unrelated prompt and polling payloads", () => {
  const h = harness();
  const auto = definition();
  h.service.put(auto);
  const db = new DatabaseSync(h.storePath);
  try {
    db.prepare("UPDATE automation_jobs SET body=json_set(body,'$.prompt',NULL) WHERE id=?").run(
      auto.id,
    );
    db.prepare("UPDATE automation_state SET state='invalid JSON' WHERE id=?").run(auto.id);
  } finally {
    db.close();
  }
  const reopened = new AutomationStore(h.storePath);
  try {
    // The automation itself no longer reads; it is passed over, its name still listed.
    expect(reopened.list()).toEqual([]);
    expect(reopened.catalog(auto.provider, auto.workspace)).toEqual([
      { id: auto.id, title: auto.title },
    ]);
  } finally {
    reopened.close();
  }
});
it("lists, restarts and admits manual work without decoding unrelated poll state", async () => {
  const h = harness();
  const auto = definition({
    trigger: {
      kind: "github",
      repository: "user/project",
      event: "pr_changed",
      pollIntervalMs: 60_000,
    },
  });
  h.service.put(auto);
  const db = new DatabaseSync(h.storePath);
  try {
    db.prepare("UPDATE automation_state SET state=? WHERE id=?").run("not valid JSON", auto.id);
  } finally {
    db.close();
  }
  expect(() => h.service.list()).not.toThrow();
  expect(h.service.list()).toEqual([auto]);
  expect(() => h.restart()).not.toThrow();
  expect(
    h.service.trigger(auto.id, { key: "manual:valid", variables: { subject: "issues" } }).status,
  ).toBe("running");
  await h.finish();
});
it("preserves legacy inline cursors across migration and subsequent restarts", () => {
  const h = harness();
  const auto = definition();
  h.service.put(auto);
  h.service.stop();
  const db = new DatabaseSync(h.storePath);
  db.exec("DROP TABLE automation_state");
  db.prepare("UPDATE automation_jobs SET state=? WHERE id=?").run(
    JSON.stringify({
      pages: [{ endpoint: "repos/user/project/issues", etag: '"legacy"', entries: [] }],
    }),
    auto.id,
  );
  db.close();
  // Reopen independently to exercise startup migration and persistence.
  const restored = new AutomationStore(h.storePath);
  const expected = {
    pages: [{ endpoint: "repos/user/project/issues", etag: '"legacy"', entries: [] }],
  };
  expect(restored.readState(auto.id)).toEqual(expected);
  restored.savePoll(auto.id, { pages: [] });
  restored.close();
  const second = new AutomationStore(h.storePath);
  expect(second.readState(auto.id)).toEqual({ pages: [] });
  second.close();
});
it("an automation another build wrote is kept and passed over: the rest start, list and run", async () => {
  const h = harness();
  const kept = definition();
  const newer = definition({ id: "newer" });
  h.service.put(kept);
  h.service.put(newer);
  const db = new DatabaseSync(h.storePath);
  try {
    db.prepare(
      "UPDATE automation_jobs SET body=json_set(body,'$.trigger',json('{\"kind\":\"lunar\"}')) WHERE id=?",
    ).run(newer.id);
  } finally {
    db.close();
  }
  expect(() => h.restart()).not.toThrow();
  expect(h.errors.some((error) => String(error).includes("newer"))).toBe(true);
  expect(h.service.list()).toEqual([kept]);
  expect(h.service.catalog(kept.provider, kept.workspace)).toContainEqual({
    id: kept.id,
    title: kept.title,
  });
  expect(h.service.handle({ type: "automation.list", requestId: "listed" })).toMatchObject({
    ok: true,
  });
  expect(
    h.service.trigger(kept.id, { key: "manual:kept", variables: { subject: "issues" } }).status,
  ).toBe("running");
  await h.finish();
  // Still stored, for a build that reads it.
  const check = new DatabaseSync(h.storePath);
  try {
    expect(check.prepare("SELECT 1 FROM automation_jobs WHERE id=?").get(newer.id)).toBeDefined();
  } finally {
    check.close();
  }
});
it("an unreadable automation with the earliest deadline never keeps the next readable one from its timer", async () => {
  const h = harness();
  const kept = { ...scheduled(), id: "kept" };
  const newer = { ...scheduled(), id: "newer" };
  h.service.put(kept);
  h.service.put(newer);
  const db = new DatabaseSync(h.storePath);
  try {
    // Another build wrote it, with a provider this build doesn't know, due before the other.
    db.prepare(
      "UPDATE automation_jobs SET body=json_set(body,'$.provider','future-provider'),due=due-60000 WHERE id=?",
    ).run(newer.id);
  } finally {
    db.close();
  }
  expect(() => h.restart()).not.toThrow();
  expect(h.timer.active.size).toBe(1);
  h.now = start;
  await h.timer.fire();
  await h.finish();
  expect(h.inputs).toHaveLength(1);
  // Told once, however often the deadline is chosen again; still stored.
  expect(h.errors.filter((error) => String(error).includes("newer"))).toHaveLength(1);
  const check = new DatabaseSync(h.storePath);
  try {
    expect(check.prepare("SELECT 1 FROM automation_jobs WHERE id=?").get(newer.id)).toBeDefined();
  } finally {
    check.close();
  }
});
