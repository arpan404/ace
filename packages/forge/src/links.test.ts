import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { ForgeStore } from "./index.ts";

const repository = { forge: "github", host: "github.com", owner: "octo", name: "ace" } as const;
const link = (number: number) => ({ threadId: "thread", pr: { repository, number } });

test("an old single PR remains linked after upgrade, beside new PRs without duplicate or reordered links", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE forge_links(thread_id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
  db.prepare("INSERT INTO forge_links VALUES (?,?)").run("thread", JSON.stringify(link(283)));
  try {
    const store = new ForgeStore(db);
    store.link(link(284));
    store.link(link(283));
    expect(store.getLinks("thread").map((entry) => entry.link.pr.number)).toEqual([284, 283]);
    const reopened = new ForgeStore(db);
    expect(reopened.getLinks("thread").map((entry) => entry.link.pr.number)).toEqual([284, 283]);
    reopened.unlink("thread", link(284).pr);
    expect(reopened.getLinks("thread").map((entry) => entry.link.pr.number)).toEqual([283]);
    reopened.unlink("thread");
    expect(reopened.getLinks("thread")).toEqual([]);
  } finally {
    db.close();
  }
});

test("identical PR numbers in different repositories stay independent and relink invalidates old state", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ForgeStore(db);
    store.link(link(283));
    const other = {
      threadId: "thread",
      pr: { repository: { ...repository, name: "other" }, number: 283 },
    };
    store.link(other);
    const before = store.getLinkState("thread", other.pr)?.generation;
    store.unlink("thread", other.pr);
    store.link(other);
    const current = store.getLinkState("thread", other.pr)?.generation;
    expect(current).toBeGreaterThan(before ?? 0);
    expect(store.getLinks("thread")).toHaveLength(2);
    store.update(
      "thread",
      {
        number: 283,
        repo: other.pr.repository,
        state: "merged",
        url: "https://github.com/octo/other/pull/283",
        updatedAt: 1,
      },
      before ?? 0,
    );
    expect(store.summaries("thread").map((pr) => pr.state)).toEqual(["open", "open"]);
  } finally {
    db.close();
  }
});
