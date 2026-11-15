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
const other = (key: string, id: string): SpadeChatItem => ({
  kind: "other",
  key,
  agent: { id, name: id },
  text: key,
});
const helper = (key: string): SpadeChatItem => ({
  kind: "helper",
  key,
  job: key,
  text: "Helper found: 7 open pull requests",
  open: false,
});

const routine = (key: string, name: string, when?: string): SpadeChatItem => ({
  kind: "routine",
  key,
  name,
  label: "9:00",
  ...(when ? { at: at(when) } : {}),
});

/** The rows as short lines: "time Today 9:00 AM", "run a b", "item you". */
const read = (rows: SpadeChatRow[]) =>
  rows.map((row) =>
    row.kind === "time"
      ? `time ${row.routine ? `${row.routine} · ` : ""}${row.label}`
      : row.kind === "run"
        ? `run ${row.items.map((item) => item.key).join(" ")}`
        : `item ${row.item.key}`,
  );

describe("the chat's rows", () => {
  test("the bot's bubbles in a row are one run; a helper line ends a run", () => {
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
    expect(read(rows)).toEqual(["time Today 9:00 AM", "item ask", "run a b", "item h", "run c"]);
  });

  test("a time line shows only after a 30-minute gap or on a new day", () => {
    const rows = spadeChatRows(
      [
        person("first", "2026-11-14T23:10:00Z"),
        bot("soon", "2026-11-14T23:39:00Z"),
        person("midnight", "2026-11-15T00:01:00Z"),
        bot("later", "2026-11-15T00:31:00Z"),
      ],
      { now, ...zone },
    );
    expect(read(rows)).toEqual([
      "time Yesterday 11:10 PM",
      "item first",
      "run soon",
      "time Today 12:01 AM",
      "item midnight",
      "time Today 12:31 AM",
      "run later",
    ]);
  });

  test("a time line names the day in the reader's words", () => {
    const lines = (when: string) =>
      read(spadeChatRows([person("x", when)], { now, ...zone }))[0];
    expect(lines("2025-12-30T18:00:00Z")).toBe("time Dec 30, 2025 6:00 PM");
    expect(lines("2026-11-03T18:00:00Z")).toBe("time Nov 3 6:00 PM");
    expect(lines("2026-11-13T03:11:00Z")).toBe("time Fri 3:11 AM");
    expect(lines("2026-11-14T23:31:00Z")).toBe("time Yesterday 11:31 PM");
  });

  test("a routine's run names itself in its time line, even a minute after the last words", () => {
    const rows = spadeChatRows(
      [
        person("ask", "2026-11-15T08:59:00Z"),
        routine("fired", "Morning check", "2026-11-15T09:00:00Z"),
        bot("brief", "2026-11-15T09:00:30Z"),
      ],
      { now, ...zone },
    );
    expect(read(rows)).toEqual([
      "time Today 8:59 AM",
      "item ask",
      "time Morning check · Today 9:00 AM",
      "run brief",
    ]);
  });

  test("every bubble keeps its exact time for hover, though only the line shows one", () => {
    const rows = spadeChatRows(
      [bot("a", "2026-11-15T09:01:00Z"), bot("b", "2026-11-15T09:12:00Z"), bot("live")],
      { now, ...zone },
    );
    const run = rows.find((row) => row.kind === "run");
    expect(run?.kind === "run" && run.whens).toEqual(["Today 9:01 AM", "Today 9:12 AM", undefined]);
  });

  test("days follow the reader's time zone", () => {
    const late = [person("late", "2026-11-15T02:00:00Z")];
    expect(read(spadeChatRows(late, { now, ...zone }))[0]).toBe("time Today 2:00 AM");
    expect(
      read(spadeChatRows(late, { now, locale: "en-US", timeZone: "America/Los_Angeles" }))[0],
    ).toBe("time Yesterday 6:00 PM");
  });

  test("a bubble stamped before what came above it never goes back in time, and an untimed one joins its run", () => {
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
      "time Today 9:04 AM",
      "item steer",
      "run went-on",
      "item sending",
      "run live",
    ]);
    const run = rows.find((row) => row.kind === "run");
    expect(run?.kind === "run" && run.whens).toEqual(["Today 9:04 AM"]);
  });

  test("another bot's bubbles run under its own name, apart from the bot's", () => {
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
      "time Yesterday 6:12 PM",
      "item s1",
      "run r1",
      "time Today 9:00 AM",
      "item s4",
    ]);
  });
});
