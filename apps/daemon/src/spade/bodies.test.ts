import { describe, expect, test } from "vitest";
import {
  maxSpadeImageBytes,
  maxSpadeRequestBytes,
  maxSpadeResponseBytes,
  maxSpadeUploadBytes,
} from "@ace/protocol";
import {
  base64Stream,
  InvalidBase64,
  isTextContentType,
  requestBodyLimit,
  responseBodyLimit,
  splitBody,
} from "./bodies.ts";

test("only a new conversation or a message takes a large body; every other route keeps the small cap", () => {
  expect(requestBodyLimit("POST", "/v1/conversations")).toBe(maxSpadeUploadBytes);
  expect(requestBodyLimit("POST", "/v1/conversations/c1/messages")).toBe(maxSpadeUploadBytes);
  expect(requestBodyLimit("POST", "/v1/conversations/c1/stop")).toBe(maxSpadeRequestBytes);
  expect(requestBodyLimit("PUT", "/v1/conversations/c1/messages")).toBe(maxSpadeRequestBytes);
  expect(requestBodyLimit("POST", "/v1/conversations/c1/messages/x")).toBe(maxSpadeRequestBytes);
  expect(maxSpadeUploadBytes).toBeGreaterThan(Math.ceil((8 * 5 * 1024 * 1024) / 3) * 4);
});

test("an image may be up to 5 MiB; other answers keep the 1 MiB cap", () => {
  expect(responseBodyLimit("GET", "/v1/images/ab12")).toBe(maxSpadeImageBytes);
  expect(responseBodyLimit("GET", "/v1/images/ab12/x")).toBe(maxSpadeResponseBytes);
  expect(responseBodyLimit("GET", "/v1/conversations")).toBe(maxSpadeResponseBytes);
});

test("JSON and text are forwarded as text; images and unknown bytes as base64", () => {
  for (const type of [
    "application/json",
    "application/json; charset=utf-8",
    "text/plain",
    "application/problem+json",
    undefined,
  ])
    expect(isTextContentType(type)).toBe(true);
  for (const type of ["image/png", "image/jpeg", "application/octet-stream"])
    expect(isTextContentType(type)).toBe(false);
});

describe("base64 in pieces", () => {
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, index) => (index * 7) % 256));
  const text = bytes.toString("base64");
  test.each([1, 3, 4, 5, 97, 1000])("decodes the same bytes cut every %i characters", (size) => {
    const stream = base64Stream();
    const out: Buffer[] = [];
    for (let at = 0; at < text.length; at += size) out.push(stream.push(text.slice(at, at + size)));
    out.push(stream.finish());
    expect(Buffer.concat(out).equals(bytes)).toBe(true);
  });
  test("refuses characters outside base64, a body cut short, and data after padding", () => {
    expect(() => base64Stream().push("ab$d")).toThrow(InvalidBase64);
    const short = base64Stream();
    short.push("abc");
    expect(() => short.finish()).toThrow(InvalidBase64);
    const padded = base64Stream();
    padded.push("YQ==");
    expect(() => padded.push("YQ==")).toThrow(InvalidBase64);
  });
});

test("a long answer is cut into pieces that join back exactly, never splitting a surrogate pair", () => {
  const body = `${"a".repeat(9)}😀${"b".repeat(9)}`;
  const pieces = splitBody(body, 10);
  expect(pieces.join("")).toBe(body);
  expect(pieces.every((piece) => piece.length <= 10)).toBe(true);
  expect(pieces.every((piece) => !/[\ud800-\udbff]$/.test(piece))).toBe(true);
  expect(splitBody("short", 10)).toEqual(["short"]);
});
