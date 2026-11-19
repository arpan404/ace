import { expect, test } from "vitest";
import { readSpadeServerFile, readSpadeTokenFile, spadeApi } from "./endpoint.ts";

const file = (value: Record<string, unknown>) => JSON.stringify(value);
const server = { address: "127.0.0.1:4100", pid: 42, version: "0.4.0", api: spadeApi };

test("a loopback server.json in this build's API is a reachable Spade", () => {
  expect(readSpadeServerFile(file(server))).toEqual({
    ok: true,
    endpoint: { host: "127.0.0.1", port: 4100, version: "0.4.0", api: spadeApi, pid: 42 },
  });
});

test("fields a newer Spade adds are ignored, not fatal", () => {
  expect(readSpadeServerFile(file({ ...server, started: 1, tls: false })).ok).toBe(true);
});

test.each([
  ["another host", { ...server, address: "10.0.0.2:4100" }, "not_loopback"],
  ["every interface", { ...server, address: "0.0.0.0:4100" }, "not_loopback"],
  ["no port", { ...server, address: "127.0.0.1:0" }, "not_loopback"],
  ["an API this build doesn't speak", { ...server, api: spadeApi + 1 }, "unsupported_api"],
  ["a Spade from before API versions", { ...server, api: undefined }, "unreadable"],
])("Spade isn't reachable at %s", (_name, value, reason) => {
  expect(readSpadeServerFile(file(value))).toEqual({ ok: false, reason });
});

test("a torn write is unreadable until Spade finishes it", () => {
  expect(readSpadeServerFile('{"address":"127.0.0.1:41')).toEqual({
    ok: false,
    reason: "unreadable",
  });
});

test("the token is the file's one line, and a short or binary file has none", () => {
  const token = "a".repeat(43);
  expect(readSpadeTokenFile(`${token}\n`)).toBe(token);
  expect(readSpadeTokenFile("short")).toBeUndefined();
  expect(readSpadeTokenFile(`${"a".repeat(20)}\u0000${"b".repeat(20)}`)).toBeUndefined();
});
