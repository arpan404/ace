import { expect, test } from "vitest";
import { SseLimitError, SseParser, type SseEvent } from "@ace/provider-kit/streams";

type Limits = ConstructorParameters<typeof SseParser>[2];

/** Feeds each chunk in order and returns what the parser dispatched. */
function parse(chunks: string[], limits?: Limits) {
  const events: SseEvent[] = [];
  const parser = new SseParser((event) => events.push(event), "", limits);
  for (const chunk of chunks) parser.feed(chunk);
  return { events, parser };
}

test("multiline data joins with newlines and keeps event types and ids, ignoring comments", () => {
  const { events } = parse([
    ": comment\r\nid: abc\revent: update\ndata: hello\r\ndata:  world\r\n\r\ndata:\n\nid: invalid\0id\ndata: last\n\n",
  ]);
  expect(events).toEqual([
    { event: "update", id: "abc", data: "hello\n world" },
    { event: "message", id: "abc", data: "" },
    { event: "message", id: "abc", data: "last" },
  ]);
});

test("a CRLF split across chunks ends one line without adding a blank event", () => {
  const { events } = parse(["data: first\n\ndata: second-start\r", "\ndata: second\r\n\r\n"]);
  expect(events.map((event) => event.data)).toEqual(["first", "second-start\nsecond"]);
});

test("a field split across chunks arrives whole", () => {
  const { events } = parse(["da", "ta: hel", "lo\n", "\n"]);
  expect(events.map((event) => event.data)).toEqual(["hello"]);
});

test("CR-only framing dispatches each event once", () => {
  const { events } = parse(["data: first\r\rdata: second\r\rdata: third\r\r"]);
  expect(events.map((event) => event.data)).toEqual(["first", "second", "third"]);
});

test("an event without its closing blank line is never dispatched", () => {
  const { events } = parse(["data: done\n\ndata: incomplete\n"]);
  expect(events.map((event) => event.data)).toEqual(["done"]);
});

test("the last event id advances only when an event completes, and retry is read", () => {
  const { events, parser } = parse([
    "id: resume\nretry: 2\ndata: first\n\nid: unfinished\ndata: dropped",
  ]);
  expect(events.map((event) => event.data)).toEqual(["first"]);
  expect(parser.lastEventId).toBe("resume");
  expect(parser.retryMs).toBe(2);
});

test("a line longer than the byte limit is refused even when it arrives in fragments", () => {
  const events: string[] = [];
  const parser = new SseParser((event) => events.push(event.data), "", { maxLineBytes: 14 });
  parser.feed("data: éééé\n\n");
  parser.feed("data: éé");
  expect(() => parser.feed("ééé")).toThrow(SseLimitError);
  expect(events).toEqual(["éééé"]);
});

test("many small data lines are refused before dispatch once the event limit counts their newlines", () => {
  expect(() => parse(["data: éé\ndata: éé\ndata: éé\n"], { maxEventBytes: 12 })).toThrow(
    "SSE event exceeded limit",
  );
});

test("byte budgets reset after each dispatched event", () => {
  const { events } = parse(["data: éé\n\ndata: éé\n\n"], { maxLineBytes: 10, maxEventBytes: 4 });
  expect(events.map((event) => event.data)).toEqual(["éé", "éé"]);
});
