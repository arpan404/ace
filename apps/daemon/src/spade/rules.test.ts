import { describe, expect, test } from "vitest";
import {
  checkLivePath,
  checkSpadePath,
  failuresAfterExit,
  findSpadeBinary,
  readServerFile,
  restartDelay,
  scopeFor,
} from "./rules.ts";

test("restarts wait 1 s, doubling each time, never more than 60 s", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map((failures) => restartDelay(failures))).toEqual([
    1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000,
  ]);
});

test("a run that stayed ready for a minute starts the backoff over; a short one keeps climbing", () => {
  expect(failuresAfterExit(5, 60_000)).toBe(1);
  expect(failuresAfterExit(5, 59_999)).toBe(6);
  expect(failuresAfterExit(5, undefined)).toBe(6);
});

const file = (value: object) => JSON.stringify(value);
describe("server.json", () => {
  test("names a loopback address and the child's pid when Spade is ready", () => {
    expect(
      readServerFile(file({ address: "127.0.0.1:4100", pid: 42, version: "0.1.0" }), 42),
    ).toEqual({ host: "127.0.0.1", port: 4100, version: "0.1.0" });
  });
  test.each([
    ["an earlier run's pid", { address: "127.0.0.1:4100", pid: 41, version: "0.1.0" }],
    ["another host", { address: "0.0.0.0:4100", pid: 42, version: "0.1.0" }],
    ["a port out of range", { address: "127.0.0.1:70000", pid: 42, version: "0.1.0" }],
    ["no version", { address: "127.0.0.1:4100", pid: 42 }],
  ])("is not ready when it names %s", (_name, value) => {
    expect(readServerFile(file(value), 42)).toBeUndefined();
  });
  test("is not ready while half written", () => {
    expect(readServerFile('{"address":"127.0.0.1:41', 42)).toBeUndefined();
  });
});

describe("paths clients may reach", () => {
  test.each([
    "/v1/conversations",
    "/v1/conversations/abc/events?after=12",
    "/v1/conversations/abc%20def/messages",
  ])("forwards %s", (path) => {
    expect(checkSpadePath(path)).toEqual({ ok: true, path });
  });
  test.each([
    ["the health check", "/health"],
    ["another API version", "/v2/conversations"],
    ["a dot segment", "/v1/../health"],
    ["an encoded dot segment", "/v1/%2e%2e/health"],
    ["an encoded slash", "/v1/a%2Fb"],
    ["an empty segment", "/v1//conversations"],
    ["a fragment", "/v1/conversations#x"],
    ["a full URL", "http://127.0.0.1:1/v1/x"],
    ["a backslash", "/v1/a\\b"],
    ["whitespace", "/v1/a b"],
    ["a broken escape", "/v1/a%zz"],
  ])("refuses %s", (_name, path) => {
    expect(checkSpadePath(path).ok).toBe(false);
  });
  test("live streams are /live paths only", () => {
    expect(checkLivePath("/v1/conversations/c1/live?after=3").ok).toBe(true);
    expect(checkLivePath("/v1/conversations/c1/events").ok).toBe(false);
    expect(checkLivePath("/v1/../live").ok).toBe(false);
  });
});

test("reading Spade needs the read scope; changing it needs operate", () => {
  expect(scopeFor("GET")).toBe("read");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const)
    expect(scopeFor(method)).toBe("operate");
});

describe("the Spade binary", () => {
  const executables = new Set(["/dev/spade", "/app/bin/spade-server"]);
  const find = (
    env: Record<string, string>,
    runtimeDirectory: string,
    platform: NodeJS.Platform = "darwin",
  ) =>
    findSpadeBinary({
      env,
      runtimeDirectory,
      platform,
      isExecutable: (path) => executables.has(path),
    });
  test("ACE_SPADE_BIN wins in development", () => {
    expect(find({ ACE_SPADE_BIN: "/dev/spade" }, "/app/bin")).toBe("/dev/spade");
  });
  test("otherwise it sits beside the bundled runtime", () => {
    expect(find({}, "/app/bin")).toBe("/app/bin/spade-server");
  });
  test("is missing, so Spade stays off, when neither exists", () => {
    expect(find({}, "/usr/local/bin")).toBeUndefined();
    expect(find({ ACE_SPADE_BIN: "/nowhere" }, "/app/bin")).toBeUndefined();
  });
});
