import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Log, message, thread, agent } from "./test-support.ts";

test("streaming changes wait for completion and cannot invalidate another search's page", () => {
  const root = mkdtempSync(join(tmpdir(), "ace-search-audit-"));
  const log = new Log(join(root, "search.sqlite"));
  try {
    const first = message("shared"),
      second = message("shared"),
      streaming = message("unfinished", false);
    log.append([
      { type: "thread.created", thread },
      { type: "item.created", item: first },
      { type: "item.created", item: second },
      { type: "item.created", item: streaming },
    ]);
    const page = log.query("shared", { limit: 1 });
    if (!page.cursor) throw new Error("Expected second page");
    const writes = log.index.status(log.headSeq()).indexWrites;
    for (let i = 0; i < 20; i++) {
      log.append([
        {
          type: "item.delta",
          itemId: streaming.id,
          agentId: agent,
          field: "text",
          append: " streamingword",
        },
      ]);
      log.index.flushCompleted();
    }
    expect(log.index.status(log.headSeq()).indexWrites).toBe(writes);
    expect(log.query("streamingword").hits).toHaveLength(0);
    const next = log.query("shared", { limit: 1, cursor: page.cursor });
    expect(next.hits).toHaveLength(1);
    expect(next.hits[0]?.itemId).not.toBe(page.hits[0]?.itemId);
    log.append([
      {
        type: "item.updated",
        item: { ...message("streamingword"), id: streaming.id, complete: true },
      },
    ]);
    expect(log.query("streamingword").hits[0]?.itemId).toBe(streaming.id);
    expect(log.query("shared", { limit: 1, cursor: page.cursor }).hits).toHaveLength(1);
    log.append([{ type: "item.deleted", itemId: first.id }]);
    expect(() => log.query("shared", { limit: 1, cursor: page.cursor ?? undefined })).toThrow(
      "search_cursor_stale",
    );
  } finally {
    log.close();
    rmSync(root, { recursive: true, force: true });
  }
});
