import { expect, test } from "vitest";
import { AppUpdateReply, AppUpdateReport } from "./app-update.ts";
import { MachineUpdateRequest, MachineUpdateResult } from "./machine-update.ts";

const base = { report: null, reportedAt: null };

test("a reply from an older daemon has no home data", () => {
  expect(AppUpdateReply.parse(base).homeData).toBeUndefined();
});

test("a reply keeps the home data it can read", () => {
  const homeData = { home: 3, daemon: 12, notify: null, spade: 4 };
  expect(AppUpdateReply.parse({ ...base, homeData }).homeData).toEqual(homeData);
});

test("home data this build can't read counts as absent rather than failing the reply", () => {
  const reply = AppUpdateReply.parse({ ...base, homeData: { home: "three" } });
  expect(reply.homeData).toBeUndefined();
  expect(reply.report).toBeNull();
});

test("desktop checks round trip through the report and instruction schemas", () => {
  const report = {
    version: "0.0.25-beta.3",
    available: null,
    downloaded: false,
    restartRequired: false,
    releaseUrl: null,
    line: "beta",
    checkedInstruction: "check-1",
  };
  const instruction = { id: "check-2", action: "check", mode: "idle", version: report.version };
  expect(AppUpdateReply.parse({ ...base, report, instruction })).toEqual({
    ...base,
    report,
    instruction,
  });
  expect(AppUpdateReport.safeParse({ ...report, line: "development" }).success).toBe(false);
  expect(AppUpdateReport.safeParse({ ...report, checkedInstruction: "" }).success).toBe(false);
});

test("a phone can parse the desktop's selected line and its check state", () => {
  const update = {
    version: "0.0.25-beta.3",
    platform: "darwin",
    arch: "arm64",
    install: "desktop",
    line: "stable",
    state: "checking",
    available: null,
    releaseUrl: null,
    blocked: null,
    ask: null,
    busy: 0,
    percent: null,
    error: null,
    last: null,
    checkedAt: null,
  };
  const request = { type: "machineUpdate.request", requestId: "check", operation: "check" };
  expect(MachineUpdateRequest.parse(request)).toEqual(request);
  const result = { type: "machineUpdate.result", requestId: "check", ok: true, update };
  expect(MachineUpdateResult.parse(result)).toEqual(result);
  expect(
    MachineUpdateResult.safeParse({ ...result, update: { ...update, percent: 101 } }).success,
  ).toBe(false);
});
