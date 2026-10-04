import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { localService, resolveDaemonHome } from "@ace/service";
import { readConfig } from "./config.ts";
import { startDaemon } from "./index.ts";

test("default config and child processes inherit an isolated user home and data directory", async () => {
  const realHome = process.env.ACE_TEST_REAL_HOME;
  if (!realHome || !process.env.ACE_HOME) throw new Error("Missing test home isolation");
  const difference = relative(realHome, homedir());
  expect(difference.split(/[\\/]/)[0] === ".." || isAbsolute(difference)).toBe(true);
  expect(readConfig().dataDir).toBe(process.env.ACE_HOME);
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `import {homedir} from 'node:os'; console.log(JSON.stringify({home:homedir(), data:process.env.ACE_HOME, guard:process.env.ACE_TEST_REAL_HOME}));`,
  ]);
  expect(JSON.parse(stdout)).toEqual({
    home: homedir(),
    data: process.env.ACE_HOME,
    guard: realHome,
  });
});

test("the test guard rejects real-home resolution and explicit data dirs before touching legacy data", async ({
  onTestFinished,
}) => {
  // Model the owner's real home inside a fixture, so a broken guard cannot touch their files.
  const root = await mkdtemp(join(tmpdir(), "ace-home-guard-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const protectedHome = join(root, "owner"),
    safeHome = join(root, "owner-other");
  await mkdir(join(protectedHome, ".ace"), { recursive: true });
  await mkdir(safeHome);
  await writeFile(join(protectedHome, ".ace/ace.db"), "legacy data");
  vi.stubEnv("ACE_TEST_REAL_HOME", protectedHome);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  for (const home of [
    protectedHome,
    join(protectedHome, "Library"),
    join(protectedHome, "child/.."),
  ]) {
    expect(() => resolveDaemonHome(home)).toThrow(/ACE_TEST_REAL_HOME guard/);
    expect(() => readConfig({}, home)).toThrow(/ACE_TEST_REAL_HOME guard/);
  }
  for (const dataDir of [
    protectedHome,
    join(protectedHome, ".ace"),
    join(protectedHome, ".ace-next"),
  ]) {
    expect(() => readConfig({ ACE_HOME: dataDir }, safeHome)).toThrow(/ACE_TEST_REAL_HOME guard/);
    expect(() => localService(dataDir)).toThrow(/ACE_TEST_REAL_HOME guard/);
    await expect(
      startDaemon({
        config: {
          dataDir,
          host: "127.0.0.1",
          port: 0,
          remotePort: 0,
          listen: "local",
          logLevel: "silent",
        },
      }),
    ).rejects.toThrow(/ACE_TEST_REAL_HOME guard/);
  }
  vi.stubEnv("HOME", protectedHome);
  vi.stubEnv("USERPROFILE", protectedHome);
  expect(() => localService(join(safeHome, "data"))).toThrow(/ACE_TEST_REAL_HOME guard/);
  await expect(
    startDaemon({
      config: {
        dataDir: join(safeHome, "data"),
        host: "127.0.0.1",
        port: 0,
        remotePort: 0,
        listen: "local",
        logLevel: "silent",
      },
    }),
  ).rejects.toThrow(/ACE_TEST_REAL_HOME guard/);
  await expect(
    promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {readConfig} from ${JSON.stringify(new URL("./config.ts", import.meta.url).href)}; readConfig();`,
      ],
      { env: { ...process.env, ACE_HOME: undefined } },
    ),
  ).rejects.toThrow(/ACE_TEST_REAL_HOME guard/);
  expect(readConfig({}, safeHome).dataDir).toBe(join(safeHome, ".ace"));
  expect(await readdir(protectedHome)).toEqual([".ace"]);
  expect(await readdir(join(protectedHome, ".ace"))).toEqual(["ace.db"]);
  expect(await readFile(join(protectedHome, ".ace/ace.db"), "utf8")).toBe("legacy data");
});
