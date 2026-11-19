import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  afterLook,
  afterUnreachable,
  isLocalMachine,
  recheckMs,
  spadePath,
  spadeStatusWith,
  daemonStatusWhileAway,
} from "./spade-route.ts";

test("the app looks for Spade before its first request, and again after Spade's files change", () => {
  expect(spadePath({ state: "unknown" }, 0)).toBe("look");
});

test("a Spade the app knows is reached directly", () => {
  expect(spadePath(afterLook(true, 0), 0)).toBe("direct");
});

test("with no Spade known, the daemon carries requests until the next look", () => {
  const route = afterLook(false, 1_000);
  expect(spadePath(route, 1_000)).toBe("daemon");
  expect(spadePath(route, 1_000 + recheckMs - 1)).toBe("daemon");
  expect(spadePath(route, 1_000 + recheckMs)).toBe("look");
});

test("a direct request that finds nobody listening sends the next ones through the daemon", () => {
  const route = afterUnreachable(50);
  expect(spadePath(route, 60)).toBe("daemon");
  expect(spadePath(route, 50 + recheckMs)).toBe("look");
});

test("Spade answering directly is ready even while the daemon is down", () => {
  expect(spadeStatusWith(undefined, { ready: true, version: "0.4.0" })).toEqual({
    state: "ready",
    version: "0.4.0",
  });
  const failed = { state: "failed" as const, reason: "The daemon lost Spade." };
  expect(spadeStatusWith(failed, { ready: true, version: undefined })).toEqual({ state: "ready" });
});

test("Spade hidden by the daemon stays hidden even when it answers the desktop app directly", () => {
  const hidden = {
    state: "off" as const,
    hidden: true,
    reason: "Spade is hidden on this machine.",
  };
  expect(spadeStatusWith(hidden, { ready: true, version: "0.4.0" })).toBe(hidden);
});

test("without a direct answer, the daemon's word stands", () => {
  const starting = { state: "starting" as const };
  expect(spadeStatusWith(starting, { ready: false })).toBe(starting);
  expect(spadeStatusWith(starting, undefined)).toBe(starting);
});

test("a direct look finding nobody overrides the daemon's last ready", () => {
  expect(spadeStatusWith({ state: "ready", version: "0.4.0" }, { ready: false })).toEqual({
    state: "off",
    reason: "Spade isn't reachable.",
  });
});

test("a ready from a daemon whose connection is gone stops counting; other states stand", () => {
  expect(daemonStatusWhileAway({ state: "ready", version: "0.4.0" })).toBeUndefined();
  const off = { state: "off" as const };
  expect(daemonStatusWhileAway(off)).toBe(off);
});

test("the host thread the daemon reports stays with a direct ready", () => {
  const thread = { id: ThreadId.parse("t1"), busy: true };
  expect(spadeStatusWith({ state: "ready", thread }, { ready: true, version: "1" })).toEqual({
    state: "ready",
    version: "1",
    thread,
  });
});

test("only a window on the daemon beside the app's Spade counts as this computer", () => {
  expect(isLocalMachine("host-a", "host-a")).toBe(true);
  expect(isLocalMachine("host-a", "host-b")).toBe(false);
  // Until the connection says which machine it is, it isn't taken to be this one.
  expect(isLocalMachine("host-a", undefined)).toBe(false);
  expect(isLocalMachine(undefined, undefined)).toBe(false);
});
