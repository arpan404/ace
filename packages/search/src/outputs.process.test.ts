import { AgentId } from "@ace/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Item } from "@ace/protocol";
import { FIELD_CAP } from "./index.ts";
import { Log, message, shell, thread, agent } from "./test-support.ts";

function paddedHalf(first: string, last: string): string {
  const remaining = FIELD_CAP - 1 - first.length - last.length;
  return first + "x ".repeat(Math.floor(remaining / 2)) + " ".repeat(remaining % 2) + last;
}

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

test("completed and streamed text retain Unicode across head and tail cap boundaries", () => {
  const text = "x".repeat(FIELD_CAP - 4) + "foo😀bar";
  const completed = message(text);
  const streamed = message("", false);
  log.append([
    { type: "item.created", item: completed },
    { type: "item.created", item: streamed },
    {
      type: "item.delta",
      itemId: streamed.id,
      agentId: AgentId.parse(streamed.agentId),
      field: "text",
      append: text,
    },
  ]);
  log.index.flush();
  expect(log.query("foo😀bar", { mode: "substring" }).hits.map((hit) => hit.itemId)).toEqual([
    completed.id,
    streamed.id,
  ]);
});

test("a Unicode character split across JSON deltas survives staging, restart and flush", () => {
  const item = message("", false);
  log.append([
    { type: "item.created", item },
    {
      type: "item.delta",
      itemId: item.id,
      agentId: AgentId.parse(item.agentId),
      field: "text",
      append: "prefix\ud83d",
    },
  ]);
  log.close();
  log = new Log(join(directory, "events.sqlite"));
  log.append([
    {
      type: "item.delta",
      itemId: item.id,
      agentId: AgentId.parse(item.agentId),
      field: "text",
      append: "\ude00suffix",
    },
  ]);
  log.index.flush();
  expect(log.query("prefix😀suffix", { mode: "substring" }).hits[0]?.itemId).toBe(item.id);
});

test("trimming a character across both caps preserves the entire retained tail", () => {
  const head = "headerneedle ";
  const tail = " tailneedle";
  const item = message(
    head +
      "x".repeat(FIELD_CAP - head.length - 1) +
      "😀" +
      "y".repeat(FIELD_CAP - 1 - tail.length) +
      tail,
  );
  log.append([{ type: "item.created", item }]);
  for (const text of ["headerneedle", "tailneedle"]) {
    const hit = log.query(text).hits[0];
    expect(hit?.itemId).toBe(item.id);
    expect(hit?.snippet.text).not.toContain("�");
  }
});

test("text streamed after an attachment keeps the path and first word searchable", () => {
  const item = Item.parse({
    ...message("", false),
    parts: [{ type: "file", path: "src/widget.ts" }],
  });
  log.append([
    { type: "item.created", item },
    {
      type: "item.delta",
      itemId: item.id,
      agentId: AgentId.parse(item.agentId),
      field: "text",
      append: "firstword",
    },
  ]);
  log.index.flush();
  for (const text of ["src/widget.ts", "firstword"])
    expect(log.query(text).hits[0]?.itemId).toBe(item.id);
});

test("every retained text boundary returns whole characters and literal highlights", () => {
  const head = paddedHalf("headstart ", " headedge ");
  const tail = paddedHalf(" tailedge ", " tailend");
  const completed = message(head + "😀" + tail);
  const streamed = message("", false);
  log.append([
    { type: "item.created", item: completed },
    { type: "item.created", item: streamed },
    {
      type: "item.delta",
      itemId: streamed.id,
      agentId: AgentId.parse(streamed.agentId),
      field: "text",
      append: head + "\ud83d",
    },
    {
      type: "item.delta",
      itemId: streamed.id,
      agentId: AgentId.parse(streamed.agentId),
      field: "text",
      append: "\ude00" + tail,
    },
  ]);
  log.index.flush();
  for (const text of ["headstart", "headedge", "tailedge", "tailend"]) {
    const hits = log.query(text).hits;
    expect(hits.map((hit) => hit.itemId)).toEqual([completed.id, streamed.id]);
    for (const hit of hits) {
      expect(hit.snippet.text.isWellFormed()).toBe(true);
      expect(hit.snippet.text).not.toContain("�");
      expect(
        hit.snippet.highlights.map((range) => hit.snippet.text.slice(range.start, range.end)),
      ).toContain(text);
    }
  }
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
