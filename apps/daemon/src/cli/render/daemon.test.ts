import { cliOutputs } from "@ace/protocol/cli-outputs";
import { describe, expect, test } from "vitest";
import { healthLines, logLine, serviceLines, startedJson, startedText } from "./daemon.ts";

describe("ace start prints what the desktop app and the login service have always read", () => {
  const local = {
    running: true as const,
    url: "http://127.0.0.1:4100",
    tokenPath: "/h/daemon-token",
  };
  const remote = {
    ...local,
    remoteUrl: "https://10.0.0.2:4101",
    fingerprint: "ab:cd",
  };

  test("its text, byte for byte", () => {
    expect(startedText(local)).toBe(
      "ace daemon: http://127.0.0.1:4100\nToken file: /h/daemon-token",
    );
    expect(startedText(remote)).toBe(
      "ace daemon: http://127.0.0.1:4100\nToken file: /h/daemon-token\nRemote: https://10.0.0.2:4101\nPublic-key SHA-256: ab:cd",
    );
  });

  test("its JSON: the same keys in the same order, valid against its schema", () => {
    expect(JSON.stringify(startedJson(local))).toBe(
      '{"running":true,"url":"http://127.0.0.1:4100","tokenPath":"/h/daemon-token"}',
    );
    expect(Object.keys(JSON.parse(JSON.stringify(startedJson(remote))))).toEqual([
      "running",
      "url",
      "tokenPath",
      "remoteUrl",
      "fingerprint",
    ]);
    expect(cliOutputs["daemon.start"].parse(startedJson(remote))).toEqual(remote);
  });
});

test("a log record reads as one line, its level coloured only when asked", () => {
  const at = new Date(2026, 10, 17, 9, 5, 3).getTime();
  const record = {
    at,
    level: "warn" as const,
    component: "engine",
    message: "slow turn",
    data: { ms: 900 },
  };
  expect(logLine(record)).toBe('2026-11-17 09:05:03 warn  engine  slow turn  {"ms":900}');
  expect(logLine({ ...record, level: "info", data: undefined })).toBe(
    "2026-11-17 09:05:03 info  engine  slow turn",
  );
  expect(logLine(record, true)).toContain("\u001b[33mwarn \u001b[0m");
  expect(logLine(record)).not.toContain("\u001b");
  expect(logLine({ ...record, data: "x".repeat(1000) }).length).toBeLessThan(500);
});

test("the daemon's health reads as words, with the next step when it's down", () => {
  expect(healthLines({ running: false })).toEqual([
    "ace isn't running.",
    "Start it with ace start, or open the app.",
  ]);
  expect(healthLines({ running: true, version: "0.0.24", ready: true })).toEqual([
    "ace is running, version 0.0.24.",
  ]);
  expect(healthLines({ running: true, version: "0.0.24" })).toContain("It is still starting up.");
});

test("the login service's state reads as what it means for the person", () => {
  expect(serviceLines("status", { active: true })).toEqual([
    "ace runs at login, and it is running.",
  ]);
  expect(serviceLines("status", { active: false })).toEqual(["The login service isn't running."]);
  expect(serviceLines("install", { active: true, linger: true })).toEqual([
    "ace runs at login now, and it is running.",
    "It keeps running after you log out.",
  ]);
  expect(serviceLines("start", { active: false })[0]).toMatch(/^✕/);
});
