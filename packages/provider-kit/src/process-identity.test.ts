import { expect, test } from "vitest";
import {
  errorInsufficientBuffer,
  errorInvalidParameter,
  filetimeToStart,
  readWindowsProcessIdentity,
  type WindowsProcessIdentityApi,
} from "./process-identity.ts";

const ownerSid = "S-1-5-21-123-456-789-1001";
const sidPointer = 0x1_000n;
const stringPointer = 0x2_000n;

type FakeFlags = {
  touched: boolean;
  closedProcess: boolean;
  closedToken: boolean;
  freedSid: boolean;
};

type FakeOptions = {
  openHandle?: unknown;
  lastError?: number;
  creation?: { low: number; high: number } | "fail";
  tokenOut?: unknown;
  tokenOpen?: "fail";
  tokenInfo?: "fail-second";
  sidConvert?: "fail";
  decode?: "invalid";
};

function fakeApi(options: FakeOptions = {}): { api: WindowsProcessIdentityApi; flags: FakeFlags } {
  const flags: FakeFlags = {
    touched: false,
    closedProcess: false,
    closedToken: false,
    freedSid: false,
  };
  const defaultProcessHandle = { process: 1 };
  const processHandle = Object.hasOwn(options, "openHandle")
    ? options.openHandle
    : defaultProcessHandle;
  const tokenHandle = { token: 1 };
  const tokenValue = Object.hasOwn(options, "tokenOut") ? options.tokenOut : tokenHandle;
  const api: WindowsProcessIdentityApi = {
    open: (pid) => {
      flags.touched = true;
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Unexpected pid");
      return processHandle;
    },
    times: (handle, creation, exit, kernel, user) => {
      flags.touched = true;
      if (handle !== processHandle) throw new Error("Unexpected process handle");
      for (const buffer of [creation, exit, kernel, user]) {
        if (!Buffer.isBuffer(buffer) || buffer.length !== 8)
          throw new Error("GetProcessTimes needs four real FILETIME buffers");
      }
      if (options.creation === "fail") return 0;
      creation.writeUInt32LE(options.creation?.low ?? 0x12345678, 0);
      creation.writeUInt32LE(options.creation?.high ?? 0x01dbabcd, 4);
      return 1;
    },
    openToken: (handle, out) => {
      flags.touched = true;
      if (handle !== processHandle) throw new Error("Unexpected process handle");
      if (options.tokenOpen === "fail") return 0;
      out[0] = tokenValue;
      return 1;
    },
    tokenInfo: (token, info, length, needed) => {
      flags.touched = true;
      if (token !== tokenValue) throw new Error("Unexpected token handle");
      if (options.tokenInfo === "fail-second" && info !== null) return 0;
      if (info === null) {
        needed[0] = 32;
        return 0;
      }
      if (length < 32) throw new Error("Token buffer too small");
      info.writeBigUInt64LE(sidPointer, 0);
      needed[0] = 32;
      return 1;
    },
    sidToString: (sid, out) => {
      flags.touched = true;
      if (sid !== sidPointer) throw new Error("Unexpected SID pointer");
      if (options.sidConvert === "fail") return 0;
      out[0] = stringPointer;
      return 1;
    },
    decodeSid: (ptr) => {
      flags.touched = true;
      if (ptr !== stringPointer) throw new Error("Unexpected SID string pointer");
      return options.decode === "invalid" ? "not-a-sid" : ownerSid;
    },
    free: (ptr) => {
      flags.touched = true;
      if (ptr !== stringPointer) throw new Error("Unexpected SID string pointer");
      flags.freedSid = true;
    },
    close: (handle) => {
      flags.touched = true;
      if (handle === processHandle) flags.closedProcess = true;
      else if (handle === tokenValue) flags.closedToken = true;
      else throw new Error("Unexpected handle to close");
    },
    lastError: () => options.lastError ?? errorInsufficientBuffer,
    unload: () => {
      flags.touched = true;
    },
  };
  return { api, flags };
}

test("FILETIME halves combine into one decimal start", () => {
  expect(filetimeToStart(0, 0)).toBe("0");
  expect(filetimeToStart(1, 0)).toBe("1");
  expect(filetimeToStart(0, 1)).toBe("4294967296");
  expect(filetimeToStart(0xffffffff, 0xffffffff)).toBe("18446744073709551615");
  expect(() => filetimeToStart(-1, 0)).toThrow();
  expect(() => filetimeToStart(0, 0x1_0000_0000)).toThrow();
});

test("a live process binds its creation start and lossless owner SID, then releases all natives", () => {
  const { api, flags } = fakeApi({ creation: { low: 2, high: 1 } });
  expect(readWindowsProcessIdentity(4242, api)).toEqual({
    start: "4294967298",
    owner: ownerSid,
  });
  expect(flags.closedProcess).toBe(true);
  expect(flags.closedToken).toBe(true);
  expect(flags.freedSid).toBe(true);
});

test("distinct creation times give distinct starts for one reused PID", () => {
  const first = fakeApi({ creation: { low: 10, high: 7 } });
  const second = fakeApi({ creation: { low: 11, high: 7 } });
  const firstIdentity = readWindowsProcessIdentity(4242, first.api);
  const secondIdentity = readWindowsProcessIdentity(4242, second.api);
  expect(firstIdentity?.start).not.toBe(secondIdentity?.start);
  expect(firstIdentity?.owner).toBe(ownerSid);
  expect(secondIdentity?.owner).toBe(ownerSid);
});

test.each([null, undefined, 0, 0n] as const)(
  "a missing open %s reports undefined without closing or freeing",
  (openHandle) => {
    const { api, flags } = fakeApi({ openHandle, lastError: errorInvalidParameter });
    expect(readWindowsProcessIdentity(4242, api)).toBeUndefined();
    expect(flags.closedProcess).toBe(false);
    expect(flags.closedToken).toBe(false);
    expect(flags.freedSid).toBe(false);
  },
);

test.each([null, undefined, 0, 0n] as const)(
  "a denied open %s throws instead of reporting absence",
  (openHandle) => {
    const { api, flags } = fakeApi({ openHandle, lastError: 5 });
    expect(() => readWindowsProcessIdentity(4242, api)).toThrow(
      "Kernel process identity unavailable",
    );
    expect(flags.closedProcess).toBe(false);
    expect(flags.closedToken).toBe(false);
    expect(flags.freedSid).toBe(false);
  },
);

test.each([
  ["creation-time read", { creation: "fail" }, { process: true, token: false }],
  ["token open", { tokenOpen: "fail" }, { process: true, token: false }],
  ["NULL token handle", { tokenOut: 0n }, { process: true, token: false }],
  ["token query", { tokenInfo: "fail-second" }, { process: true, token: true }],
  ["SID conversion", { sidConvert: "fail" }, { process: true, token: true }],
] as const)("a failed %s throws and still closes what it opened", (_, options, closed) => {
  const { api, flags } = fakeApi(options);
  expect(() => readWindowsProcessIdentity(4242, api)).toThrow(
    "Kernel process identity unavailable",
  );
  expect({ process: flags.closedProcess, token: flags.closedToken }).toEqual(closed);
  expect(flags.freedSid).toBe(false);
});

test("an invalid SID string throws and still frees and closes", () => {
  const { api, flags } = fakeApi({ decode: "invalid" });
  expect(() => readWindowsProcessIdentity(4242, api)).toThrow();
  expect(flags.closedProcess).toBe(true);
  expect(flags.closedToken).toBe(true);
  expect(flags.freedSid).toBe(true);
});

test("an invalid PID is rejected before touching Win32", () => {
  const { api, flags } = fakeApi({});
  expect(() => readWindowsProcessIdentity(0, api)).toThrow();
  expect(flags.touched).toBe(false);
  expect(flags.closedProcess).toBe(false);
});
