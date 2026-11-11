import { expect, it } from "vitest";
import {
  HTTP_CHUNK_BYTES,
  RequestHead,
  abortFrame,
  bodyFrame,
  chunks,
  creditFrame,
  decodeFrame,
  endFrame,
  headFrame,
  isEventStream,
  requestHeaders,
  responseHeaders,
} from "./wire.ts";

it("every frame kind reads back as what was written", () => {
  const head = {
    method: "POST",
    origin: "https://relay.example",
    prefix: "/m/HOST",
    path: "/mcp?x=1",
    headers: [["authorization", "Bearer secret"]] as [string, string][],
  };
  const decoded = decodeFrame(headFrame(head));
  expect(decoded.kind).toBe("head");
  expect(RequestHead.parse(decoded.kind === "head" ? decoded.head : undefined)).toEqual(head);
  expect(decodeFrame(bodyFrame(new Uint8Array([7, 8, 9])))).toEqual({
    kind: "body",
    bytes: new Uint8Array([7, 8, 9]),
  });
  expect(decodeFrame(endFrame())).toEqual({ kind: "end" });
  expect(decodeFrame(abortFrame())).toEqual({ kind: "abort" });
  expect(decodeFrame(creditFrame(3_000_000))).toEqual({ kind: "credit", bytes: 3_000_000 });
});

it("unknown frames, malformed credit and oversized chunks are refused", () => {
  expect(() => decodeFrame(new Uint8Array([9]))).toThrow();
  expect(() => decodeFrame(new Uint8Array([5, 1, 2]))).toThrow();
  expect(() => bodyFrame(new Uint8Array(HTTP_CHUNK_BYTES + 1))).toThrow();
});

it("a large body splits into chunks that each fit a frame and join back to the body", () => {
  const body = new Uint8Array(HTTP_CHUNK_BYTES * 2 + 5).map((_, index) => index % 251);
  const parts = [...chunks(body)];
  expect(parts.map((part) => part.length)).toEqual([HTTP_CHUNK_BYTES, HTTP_CHUNK_BYTES, 5]);
  expect(new Uint8Array(parts.flatMap((part) => [...part]))).toEqual(body);
  expect([...chunks(new Uint8Array(0))]).toEqual([]);
});

it("a forwarded request keeps Authorization and drops hop-by-hop and caller-address headers", () => {
  const kept = requestHeaders(
    new Headers({
      authorization: "Bearer token",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      connection: "keep-alive, x-private",
      "x-private": "hop",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      host: "relay.example",
      "content-length": "12",
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "203.0.113.9",
      "ace-relay-account": "user_a",
    }),
  );
  expect(Object.fromEntries(kept)).toEqual({
    authorization: "Bearer token",
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
  });
});

it("a daemon's response can't set cookies or origin-wide policy on the shared relay origin", () => {
  const kept = responseHeaders(
    new Headers({
      "content-type": "text/event-stream",
      "www-authenticate": 'Bearer resource_metadata="https://relay.example/x"',
      location: "https://client.example/callback",
      "set-cookie": "session=1; Path=/",
      "strict-transport-security": "max-age=1",
      "clear-site-data": '"*"',
      "content-length": "4",
      connection: "close",
    }),
  );
  expect(Object.fromEntries(kept)).toEqual({
    "content-type": "text/event-stream",
    "www-authenticate": 'Bearer resource_metadata="https://relay.example/x"',
    location: "https://client.example/callback",
  });
});

it("only event-stream responses count as long-lived streams", () => {
  const head = (type: string) => ({
    status: 200,
    headers: [["Content-Type", type]] as [string, string][],
  });
  expect(isEventStream(head("text/event-stream; charset=utf-8"))).toBe(true);
  expect(isEventStream(head("application/json"))).toBe(false);
  expect(isEventStream({ status: 204, headers: [] })).toBe(false);
});
