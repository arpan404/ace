import { expect, test } from "vitest";
import { createKillOnCloseJob, killOnCloseInfo, type WindowsJobApi } from "./windows-job.ts";

function fakeApi(
  behavior: { arm?: boolean; join?: boolean; openThrows?: boolean } = {},
): WindowsJobApi & { calls: string[] } {
  const calls: string[] = [];
  const job = { handle: "job" };
  const target = { handle: "process" };
  return {
    calls,
    create: () => {
      calls.push("create");
      return job;
    },
    setKillOnClose: () => {
      calls.push("setKillOnClose");
      return behavior.arm ?? true;
    },
    openProcess: () => {
      calls.push("openProcess");
      if (behavior.openThrows === true) throw new Error("access denied");
      return target;
    },
    assignProcess: () => {
      calls.push("assignProcess");
      return behavior.join ?? true;
    },
    close: () => {
      calls.push("close");
    },
    unload: () => {
      calls.push("unload");
    },
  };
}

test("the limit block arms kill-on-close at the documented offset", () => {
  const info = killOnCloseInfo();
  // JOBOBJECT_BASIC_LIMIT_INFORMATION: 8 + 8 + LimitFlags at 16, tail follows the pointer width.
  expect(info.length).toBe(process.arch === "ia32" ? 44 : 56);
  expect(info.readUInt32LE(16)).toBe(0x2000);
  expect(info.subarray(0, 16).every((byte) => byte === 0)).toBe(true);
  expect(info.subarray(20).every((byte) => byte === 0)).toBe(true);
});

test("a tree joins its job and the job is released on disposal", () => {
  const api = fakeApi();
  const job = createKillOnCloseJob(() => api);
  expect(job).toBeDefined();
  job?.assign(4242);
  job?.dispose();
  expect(api.calls).toEqual([
    "create",
    "setKillOnClose",
    "openProcess",
    "assignProcess",
    "close",
    "close",
    "unload",
  ]);
});

test("a missing Job Object platform keeps the tree stop as the owner", () => {
  const api = fakeApi();
  expect(
    createKillOnCloseJob(() => {
      throw new Error("kernel32 unavailable");
    }),
  ).toBeUndefined();
  expect(api.calls).toEqual([]);
});

test("an unarmable job unloads without holding a handle", () => {
  const api = fakeApi({ arm: false });
  expect(createKillOnCloseJob(() => api)).toBeUndefined();
  expect(api.calls).toEqual(["create", "setKillOnClose", "unload"]);
});

test("a denied join keeps the tree stop and still releases the job", () => {
  const api = fakeApi({ join: false });
  const job = createKillOnCloseJob(() => api);
  expect(() => job?.assign(4242)).not.toThrow();
  job?.dispose();
  expect(api.calls).toEqual([
    "create",
    "setKillOnClose",
    "openProcess",
    "assignProcess",
    "close",
    "close",
    "unload",
  ]);
});

test("an opener failure keeps the tree stop and still releases the job", () => {
  const api = fakeApi({ openThrows: true });
  const job = createKillOnCloseJob(() => api);
  expect(() => job?.assign(4242)).not.toThrow();
  job?.dispose();
  expect(api.calls).toEqual(["create", "setKillOnClose", "openProcess", "close", "unload"]);
});

test("disposal releases the handle once and later joins are ignored", () => {
  const api = fakeApi();
  const job = createKillOnCloseJob(() => api);
  job?.dispose();
  job?.dispose();
  job?.assign(4242);
  expect(api.calls).toEqual(["create", "setKillOnClose", "close", "unload"]);
});
