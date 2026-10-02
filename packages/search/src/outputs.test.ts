import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Item } from "@ace/protocol";
import { Log, shell, thread, agent } from "./test-support.ts";

let directory: string;
let log: Log;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ace-search-output-"));
  log = new Log(join(directory, "events.sqlite"));
  log.append([{ type: "thread.created", thread }]);
});
afterEach(() => {
  log.close();
  rmSync(directory, { recursive: true, force: true });
});

test("bounded output reads keep whole Unicode characters at both ends", () => {
  const item = shell(
    "前方検索 " + "😀".repeat(40_000) + " 中間検索 " + "😀".repeat(40_000) + " 後方検索",
  );
  log.append([{ type: "item.created", item }]);
  for (const text of ["前方検索", "後方検索"]) {
    const hit = log.query(text, { mode: "substring" }).hits[0];
    expect(hit?.itemId).toBe(item.id);
    expect(hit?.snippet.text).not.toContain("�");
  }
  expect(log.query("中間検索", { mode: "substring" }).hits).toEqual([]);
});

test("notice and reasoning accept both text fields and reject unrelated output", () => {
  for (const type of ["notice", "reasoning"] as const) {
    const item = Item.parse({
      id: type,
      agentId: agent,
      type,
      complete: false,
      createdAt: 1,
      text: "",
      level: "info",
    });
    log.append([{ type: "item.created", item }]);
    for (const field of ["text", "reasoning", "output"] as const)
      log.append([
        {
          type: "item.delta",
          itemId: item.id,
          agentId: agent,
          field,
          append: field === "output" ? " forbiddenneedle" : `${type}${field} `,
        },
      ]);
    log.index.flush();
    for (const field of ["text", "reasoning"])
      expect(log.query(`${type}${field}`).hits[0]?.itemId).toBe(item.id);
  }
  expect(log.query("forbiddenneedle").hits).toEqual([]);
});

test("non-shell tool calls reject output deltas", () => {
  const base = shell("", false);
  if (base.type !== "tool_call") throw new Error("Expected shell");
  const item = Item.parse({
    ...base,
    call: { ...base.call, kind: "file.read", detail: { kind: "file.read", path: "file.ts" } },
  });
  log.append([
    { type: "item.created", item },
    {
      type: "item.delta",
      itemId: item.id,
      agentId: agent,
      field: "output",
      append: " forbiddenneedle",
    },
  ]);
  log.index.flush();
  expect(log.query("forbiddenneedle").hits).toEqual([]);
  expect(log.query("file").hits[0]?.itemId).toBe(item.id);
});
