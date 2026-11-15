import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeLiveFrame,
  spadeBubbles,
  spadeChatRows,
  spadeView,
  type SpadeChatItem,
  type SpadeChatRow,
} from "./index.ts";

const zone = { locale: "en-US", timeZone: "UTC" };
const at = (iso: string) => Date.parse(iso);
const now = at("2026-11-15T12:00:00Z");

const bot = (key: string, when?: string): SpadeChatItem => ({
  kind: "bot",
  key,
  text: key,
  live: false,
  end: undefined,
  failure: undefined,
  images: [],
  documents: [],
  ...(when ? { at: at(when) } : {}),
});
const person = (key: string, when?: string): SpadeChatItem => ({
  kind: "person",
  key,
  text: key,
  images: [],
  documents: [],
  voice: undefined,
  sending: when === undefined,
  ...(when ? { at: at(when) } : {}),
});
const helper = (key: string): SpadeChatItem => ({
  kind: "helper",
  key,
  job: key,
  text: "Helper found: 7 open pull requests",
  open: false,
});

/** The rows as short lines: "day Today", "run 9:00 AM a b", "item you". */
const read = (rows: SpadeChatRow[]) =>
  rows.map((row) =>
    row.kind === "day"
      ? `day ${row.label}`
      : row.kind === "run"
        ? `run ${row.time ?? "-"} ${row.items.map((item) => item.key).join(" ")}`
        : `item ${row.item.key}`,
  );

describe("the chat's rows", () => {
  test("the bot's bubbles in a row are one run, timed when it began; a helper line ends a run", () => {
    const rows = spadeChatRows(
      [
        person("ask", "2026-11-15T09:00:00Z"),
        bot("a", "2026-11-15T09:01:00Z"),
        bot("b", "2026-11-15T09:02:00Z"),
        helper("h"),
        bot("c", "2026-11-15T09:03:00Z"),
      ],
      { now, ...zone },
    );
    expect(read(rows)).toEqual([
      "day Today",
      "item ask",
      "run 9:01 AM a b",
      "item h",
      "run 9:03 AM c",
    ]);
  });

  test("a day line comes before the first thing said each day, in the reader's words", () => {
    const rows = spadeChatRows(
      [
        person("old", "2025-12-30T18:00:00Z"),
        person("week", "2026-11-03T18:00:00Z"),
        person("monday", "2026-11-09T18:00:00Z"),
        person("yesterday", "2026-11-14T18:12:00Z"),
        bot("reply", "2026-11-14T18:13:00Z"),
        bot("morning", "2026-11-15T09:00:00Z"),
      ],
      { now, ...zone },
    );
    expect(read(rows)).toEqual([
      "day Dec 30, 2025",
      "item old",
      "day Tue, Nov 3",
      "item week",
      "day Monday",
      "item monday",
      "day Yesterday",
      "item yesterday",
      "run 6:13 PM reply",
      "day Today",
      "run 9:00 AM morning",
    ]);
  });

  test("days follow the reader's time zone", () => {
    const late = [person("late", "2026-11-15T02:00:00Z")];
    expect(read(spadeChatRows(late, { now, ...zone }))[0]).toBe("day Today");
    expect(
      read(spadeChatRows(late, { now, locale: "en-US", timeZone: "America/Los_Angeles" }))[0],
    ).toBe("day Yesterday");
  });

  test("a bubble stamped before what came above it never goes back a day, and an untimed one joins its run", () => {
    const rows = spadeChatRows(
      [
        person("steer", "2026-11-15T09:04:00Z"),
        // The reply began before the message that steered it.
        bot("went-on", "2026-11-15T08:59:00Z"),
        person("sending"),
        bot("live"),
      ],
      { now, ...zone },
    );
    expect(read(rows)).toEqual([
      "day Today",
      "item steer",
      "run 9:04 AM went-on",
      "item sending",
      "run - live",
    ]);
  });

  test("another bot's bubbles run under its own name, apart from the bot's", () => {
    const other = (key: string, id: string): SpadeChatItem => ({
      kind: "other",
      key,
      agent: { id, name: id },
      text: key,
    });
    const rows = spadeChatRows([other("x1", "flights"), other("x2", "flights"), bot("a")], {
      now,
      ...zone,
    });
    expect(rows.map((row) => (row.kind === "run" ? row.sender : row.kind))).toEqual([
      { kind: "other", agent: { id: "flights", name: "flights" } },
      { kind: "bot" },
    ]);
  });
});

describe("a conversation's times", () => {
  test("come from when Spade stored each message and when each reply began", () => {
    const state = emptySpadeConversation();
    let seq = 0;
    const stored = (when: string, event: Record<string, unknown>) => {
      const input = parseSpadeLiveFrame(
        "stored",
        JSON.stringify({ seq: ++seq, at: at(when), event }),
      );
      if (input) foldSpade(state, input);
    };
    stored("2026-11-14T18:12:00Z", { type: "user_message", text: "Watch arpan404/ace" });
    stored("2026-11-14T18:12:30Z", { type: "reply_started", reply: "r1" });
    stored("2026-11-14T18:13:00Z", { type: "reply_finished", reply: "r1", text: "On it." });
    stored("2026-11-15T09:00:00Z", { type: "user_message", text: "Anything new?" });
    const rows = spadeChatRows(spadeBubbles(spadeView(state)), { now, ...zone });
    expect(read(rows)).toEqual([
      "day Yesterday",
      "item s1",
      "run 6:12 PM r1",
      "day Today",
      "item s4",
    ]);
  });
});
