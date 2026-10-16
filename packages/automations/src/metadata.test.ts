import { AutomationStore } from "./index.ts";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { harness, definition } from "./service-test-support.ts";
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
    expect(() => reopened.list()).toThrow();
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
