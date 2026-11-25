// SPDX-License-Identifier: Apache-2.0

/**
 * The TypeScript backend's refusals are the catalog's words (ADR 0225 safeguard 3): one message,
 * whichever backend answered, so the catalog is the only place a word is written.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { catalogWord, type CatalogWord } from "./catalog.ts";
import { type DeviceError, resolveAndroidSDK, resolveXcode } from "./sdk.ts";

let root: string;
let tools: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-devices-sdk-"));
  tools = join(root, "bin");
  await mkdir(tools, { recursive: true });
  for (const name of ["xcode-select", "xcrun", "open"])
    await writeFile(join(tools, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const word = (key: string): [string, string, string][] => {
  const entry: CatalogWord = catalogWord(key);
  return [[entry.code, entry.message, entry.hint]];
};

const claimed = (error: unknown): [string, string, string][] => {
  const failure = error as DeviceError;
  expect(failure).toBeInstanceOf(Error);
  return [[failure.code, failure.message, failure.hint]];
};

async function refusal(run: Promise<unknown>) {
  return run.then(
    () => expect.unreachable("a refusal"),
    (error: unknown) => claimed(error),
  );
}

const unrunProbe = async () => {
  throw new Error("probe could not run");
};
const failedProbe = async () => ({ stdout: "/Applications/Xcode.app\n", stderr: "", code: 1 });

test("Xcode's missing tools are the catalog's word", async () => {
  const error = await refusal(
    resolveXcode({ platform: "darwin", home: root, env: { PATH: join(root, "empty") } }),
  );
  expect(error).toEqual(word("xcodeMissing"));
});

test("a selection probe that could not run names its own word", async () => {
  const error = await refusal(
    resolveXcode({ platform: "darwin", home: root, env: { PATH: tools }, probe: unrunProbe }),
  );
  expect(error).toEqual(word("xcodeUnavailable"));
});

test("a failing selection is a full-Xcode refusal, not an unavailable one", async () => {
  const error = await refusal(
    resolveXcode({ platform: "darwin", home: root, env: { PATH: tools }, probe: failedProbe }),
  );
  expect(error).toEqual(word("xcodeNotFull"));
});

test("Windows asks for a paired Mac and other hosts for a Mac daemon", async () => {
  expect(
    await refusal(resolveXcode({ platform: "win32", home: root, env: { PATH: tools } })),
  ).toEqual(word("iosNeedsMac"));
  expect(
    await refusal(resolveXcode({ platform: "linux", home: root, env: { PATH: tools } })),
  ).toEqual(word("iosNeedsMacOs"));
});

test("a host without an Android SDK names the install that fixes it", async () => {
  const missing = await refusal(resolveAndroidSDK({ platform: "darwin", home: root, env: {} }));
  expect(missing).toEqual(word("sdkMissing"));
});

test("Linux tells arm64 and other architectures apart", async () => {
  const arm = await refusal(
    resolveAndroidSDK({ platform: "linux", arch: "arm64", home: root, env: {} }),
  );
  expect(arm).toEqual(word("adbMissingArm"));
  const other = await refusal(
    resolveAndroidSDK({ platform: "linux", arch: "x64", home: root, env: {} }),
  );
  expect(other).toEqual(word("adbMissingLinux"));
});
