import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { Log, message, thread } from "./test-support.ts";

test("only requested kinds occupy search pages and the cursor stays bound to them", () => {
  const directory = mkdtempSync(join(tmpdir(), "ace-search-kinds-"));
  const log = new Log(join(directory, "events.sqlite"));
  try {
    const visible = message("needle");
    const hidden = Item.parse({
      ...visible,
      id: "hidden-reasoning",
      type: "reasoning",
      text: "needle",
    });
    log.append([
      { type: "thread.created", thread: { ...thread, title: "needle" } },
      { type: "item.created", item: hidden },
      { type: "item.created", item: visible },
    ]);
    const options = {
      limit: 1,
      filters: { kinds: ["thread", "message", "tool_call", "artifact"] },
    } as const;
    const first = log.query("needle", {
      ...options,
      filters: { kinds: [...options.filters.kinds] },
    });
    expect(first.hits.map((hit) => hit.kind)).toEqual(["thread"]);
    const next = log.query("needle", {
      limit: 1,
      filters: { kinds: [...options.filters.kinds] },
      cursor: first.cursor ?? "missing",
    });
    expect(next.hits.map((hit) => hit.itemId)).toEqual([visible.id]);
    expect(next.cursor).toBeNull();
    expect(() =>
      log.query("needle", { filters: { kinds: ["reasoning"] }, cursor: first.cursor ?? "missing" }),
    ).toThrow("search_invalid_query");
    expect(
      log.query("needle", { filters: { kinds: ["reasoning"] } }).hits.map((hit) => hit.itemId),
    ).toEqual([hidden.id]);
  } finally {
    log.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
