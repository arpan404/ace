import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Log, message, thread } from "./test-support.ts";

test("cursor pages preserve relevance order across unequal scores and recent-title ties", () => {
  const directory = mkdtempSync(join(tmpdir(), "ace-search-pages-"));
  const log = new Log(join(directory, "events.sqlite"));
  try {
    const compact = message("rankingword");
    const verbose = message("rankingword " + "unrelated ".repeat(1000));
    log.append([
      { type: "thread.created", thread: { ...thread, title: "rankingword" } },
      { type: "item.created", item: verbose },
      { type: "item.created", item: compact },
    ]);
    const first = log.query("rankingword", { limit: 1 });
    expect(first.hits[0]?.kind).toBe("thread");
    const second = log.query("rankingword", { limit: 1, cursor: first.cursor ?? "missing" });
    expect(second.hits[0]?.itemId).toBe(compact.id);
    const third = log.query("rankingword", { limit: 1, cursor: second.cursor ?? "missing" });
    expect(third.hits[0]?.itemId).toBe(verbose.id);
    expect(third.cursor).toBeNull();
    log.append(
      [
        {
          type: "thread.created",
          thread: { ...thread, id: ThreadId.parse("otherthread"), title: "Other" },
        },
      ],
      ThreadId.parse("otherthread"),
    );
    const titles = log.query("", { scope: "threads", limit: 1 });
    const next = log.query("", { scope: "threads", limit: 1, cursor: titles.cursor ?? "missing" });
    expect([titles.hits[0]?.threadId, next.hits[0]?.threadId]).toEqual([thread.id, "otherthread"]);
    expect(next.cursor).toBeNull();
  } finally {
    log.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
