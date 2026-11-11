import { expect, test } from "vitest";
import { sseDecoder, SseTooLarge } from "./sse.ts";

test("events split across chunks arrive whole, in order", () => {
  const decoder = sseDecoder(1024);
  const stream = 'event: stored\ndata: {"seq":1}\n\nevent: delta\ndata: {"text":"hi"}\n\n';
  const events = [...stream].flatMap((character) => decoder.push(character));
  expect(events).toEqual([
    { event: "stored", data: '{"seq":1}' },
    { event: "delta", data: '{"text":"hi"}' },
  ]);
});

test("CRLF and CR line endings, data lines joined, comments and ids skipped", () => {
  const decoder = sseDecoder(1024);
  expect(decoder.push(": keepalive\r\nid: 7\r\nevent: snapshot\r\ndata: a\r")).toEqual([]);
  expect(decoder.push("\ndata: b\r\rdata: plain\n\n")).toEqual([
    { event: "snapshot", data: "a\nb" },
    { event: "message", data: "plain" },
  ]);
});

test("an event with no data is not dispatched", () => {
  expect(sseDecoder(1024).push("event: stored\n\n")).toEqual([]);
});

test("an event larger than the limit fails instead of growing without bound", () => {
  const decoder = sseDecoder(16);
  expect(() => decoder.push(`data: ${"x".repeat(32)}\n`)).toThrow(SseTooLarge);
  expect(() => sseDecoder(16).push(`data: ${"x".repeat(32)}`)).toThrow(SseTooLarge);
});
