import { execFile } from "node:child_process";
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { openRegistry, runAccountsCommand } from "@ace/accounts";
import { TerminalManager } from "@ace/terminal";
import { readConfig, readHistoryInstances } from "./index.ts";
import { testHomeEnvironment } from "../../../scripts/test-home-environment.ts";
import { loadNotificationChannels } from "./notification-config.ts";
import { openDaemonModels, readModelInstances } from "./models.ts";
import { testHomes, ownedDaemonAttempt, daemonConfig } from "./testing/test-home-fixture.ts";

test("an inherited accounts database cannot divert daemon or accounts CLI writes into a protected home", async ({
  onTestFinished,
}) => {
  const { protectedHome, safeHome } = await testHomes(onTestFinished);
  const database = join(protectedHome, "accounts.sqlite");
  const registry = await openRegistry(database);
  registry.close();
  await chmod(database, 0o644);
  const bytes = await readFile(database);
  vi.stubEnv("ACE_TEST_REAL_HOME", protectedHome);
  vi.stubEnv("ACE_ACCOUNTS_DB", database);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  await expect(
    ownedDaemonAttempt(onTestFinished, { config: daemonConfig(safeHome) }),
  ).rejects.toThrow(/ACE_TEST_REAL_HOME guard/);
  let output = "";
  await expect(
    runAccountsCommand(["accounts", "list"], {
      write: (text) => {
        output += text;
      },
    }),
  ).rejects.toThrow(/ACE_TEST_REAL_HOME guard/);
  expect(output).toBe("");
  expect(await readFile(database)).toEqual(bytes);
  expect((await stat(database)).mode & 0o777).toBe(0o644);
});

test("worker and fixture children discard ambient account and provider history selectors", async ({
  onTestFinished,
}) => {
  const { protectedHome, safeHome } = await testHomes(onTestFinished);
  const env = testHomeEnvironment(safeHome, protectedHome, {
    ...process.env,
    ACE_ACCOUNTS_DB: join(protectedHome, "accounts.sqlite"),
    ACE_HOME: join(protectedHome, ".ace"),
    CODEX_HOME: join(protectedHome, ".codex"),
    CLAUDE_CONFIG_DIR: join(protectedHome, ".claude"),
    ACE_HISTORY_INSTANCES: JSON.stringify([
      { id: "protected", provider: "codex", homeDir: protectedHome },
    ]),
    ACE_MODEL_INSTANCES: JSON.stringify([{ id: "protected", cwd: protectedHome }]),
    ZDOTDIR: protectedHome,
    BASH_ENV: join(protectedHome, ".bashrc"),
    ENV: join(protectedHome, ".profile"),
    INPUTRC: join(protectedHome, ".inputrc"),
    ACE_APNS_KEY_FILE: join(protectedHome, "key.pem"),
  });
  expect(readConfig(env, safeHome).dataDir).toBe(join(safeHome, ".ace"));
  expect(readHistoryInstances(env, safeHome)).toEqual([]);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runAccountsCommand} from '@ace/accounts'; await runAccountsCommand(['accounts','list']);`,
    ],
    { env, cwd: import.meta.dirname },
  );
  expect(stdout.trim()).toBe("[]");
  expect(await readdir(protectedHome)).toEqual([]);
  expect((await stat(join(safeHome, ".ace/accounts.sqlite"))).isFile()).toBe(true);
});

test("provider history overrides are rejected before protected history can be scanned", async ({
  onTestFinished,
}) => {
  const { protectedHome, safeHome } = await testHomes(onTestFinished);
  vi.stubEnv("ACE_TEST_REAL_HOME", protectedHome);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  for (const env of [
    { CODEX_HOME: protectedHome },
    { CLAUDE_CONFIG_DIR: protectedHome },
    {
      ACE_HISTORY_INSTANCES: JSON.stringify([
        { id: "protected", provider: "codex", homeDir: protectedHome },
      ]),
    },
  ])
    expect(() => readHistoryInstances(env, safeHome)).toThrow(/ACE_TEST_REAL_HOME guard/);
  await expect(
    ownedDaemonAttempt(onTestFinished, {
      config: daemonConfig(safeHome),
      history: { instances: [{ id: "protected", provider: "codex", homeDir: protectedHome }] },
    }),
  ).rejects.toThrow(/ACE_TEST_REAL_HOME guard/);
  expect(await readdir(protectedHome)).toEqual([]);
});

test("restored notification key paths are rejected before loading protected key files", async ({
  onTestFinished,
}) => {
  const { protectedHome } = await testHomes(onTestFinished);
  const key = join(protectedHome, "key.pem");
  await writeFile(key, "protected key bytes");
  vi.stubEnv("ACE_TEST_REAL_HOME", protectedHome);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  for (const env of [{ ACE_APNS_KEY_FILE: key }, { ACE_VAPID_KEY_FILE: key }])
    await expect(loadNotificationChannels(env)).rejects.toThrow(/ACE_TEST_REAL_HOME guard/);
  expect(await readFile(key, "utf8")).toBe("protected key bytes");
});

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
test("restored terminal startup selectors are refused before launching a shell", async ({
  onTestFinished,
}) => {
  const { protectedHome, safeHome } = await testHomes(onTestFinished);
  const marker = join(protectedHome, "startup-read");
  await writeFile(join(protectedHome, ".zshenv"), `printf read > ${quote(marker)}\n`);
  vi.stubEnv("ACE_TEST_REAL_HOME", protectedHome);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const manager = new TerminalManager({ graceMs: 0 });
  onTestFinished(() => manager.closeAll());
  expect(() =>
    manager.openTerminal({
      cwd: safeHome,
      shell: "/bin/sh",
      env: { ZDOTDIR: protectedHome },
      cols: 80,
      rows: 24,
      name: "refused",
    }),
  ).toThrow(/ACE_TEST_REAL_HOME guard/);
  expect(await readdir(protectedHome)).toEqual([".zshenv"]);
});

test("restored model instance homes and environment selectors cannot scan protected configuration", async ({
  onTestFinished,
}) => {
  const { protectedHome, safeHome } = await testHomes(onTestFinished);
  vi.stubEnv("ACE_TEST_REAL_HOME", protectedHome);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  for (const instance of [
    { cwd: protectedHome },
    { cwd: safeHome, homeDir: protectedHome },
    { cwd: safeHome, env: { CODEX_HOME: protectedHome } },
  ]) {
    const input = {
      id: "protected",
      provider: "codex" as const,
      loginRevision: "0",
      executable: process.execPath,
      ...instance,
    };
    expect(() => readModelInstances({ ACE_MODEL_INSTANCES: JSON.stringify([input]) })).toThrow(
      /ACE_TEST_REAL_HOME guard/,
    );
    expect(() => openDaemonModels(safeHome, [input])).toThrow(/ACE_TEST_REAL_HOME guard/);
    await expect(
      ownedDaemonAttempt(onTestFinished, {
        config: daemonConfig(safeHome),
        modelInstances: [input],
      }),
    ).rejects.toThrow(/ACE_TEST_REAL_HOME guard/);
  }
  expect(() => openDaemonModels(protectedHome, [])).toThrow(/ACE_TEST_REAL_HOME guard/);
  expect(await readdir(safeHome)).toEqual([]);
  expect(await readdir(protectedHome)).toEqual([]);
});

test("device live opt-ins reach workers while other ACE selectors stay discarded", async ({
  onTestFinished,
}) => {
  const { protectedHome, safeHome } = await testHomes(onTestFinished);
  const env = testHomeEnvironment(safeHome, protectedHome, {
    ...process.env,
    ACE_DEVICE_LIVE: "1",
    ACE_DEVICE_LIVE_IOS_UUID: "ios-device-uuid",
    ACE_DEVICE_LIVE_ANDROID_AVD: "android-avd-name",
    ACE_DEVICE_VIDEO_LIVE: "1",
    ACE_DEVICE_GESTURE_LIVE: "1",
    ACE_ACCOUNTS_DB: join(protectedHome, "accounts.sqlite"),
  });
  expect(env["ACE_DEVICE_LIVE"]).toBe("1");
  expect(env["ACE_DEVICE_LIVE_IOS_UUID"]).toBe("ios-device-uuid");
  expect(env["ACE_DEVICE_LIVE_ANDROID_AVD"]).toBe("android-avd-name");
  expect(env["ACE_DEVICE_VIDEO_LIVE"]).toBe("1");
  expect(env["ACE_DEVICE_GESTURE_LIVE"]).toBe("1");
  expect(env["ACE_ACCOUNTS_DB"]).toBeUndefined();
  expect(env["HOME"]).toBe(safeHome);
});

test("android device homes stay private unless live devices are opted in", async ({
  onTestFinished,
}) => {
  const { protectedHome, safeHome } = await testHomes(onTestFinished);
  const rest = { ...process.env };
  delete rest["ANDROID_USER_HOME"];
  delete rest["ANDROID_AVD_HOME"];
  const privateEnv = testHomeEnvironment(safeHome, protectedHome, { ...rest });
  expect(privateEnv["ANDROID_USER_HOME"]).toBe(join(safeHome, ".android"));
  expect(privateEnv["ANDROID_AVD_HOME"]).toBe(join(safeHome, ".android/avd"));
  const liveEnv = testHomeEnvironment(safeHome, protectedHome, {
    ...rest,
    ACE_DEVICE_LIVE: "1",
  });
  expect(liveEnv["ANDROID_USER_HOME"]).toBe(join(protectedHome, ".android"));
  expect(liveEnv["ANDROID_AVD_HOME"]).toBe(join(protectedHome, ".android/avd"));
  expect(liveEnv["HOME"]).toBe(safeHome);
});

test.skipIf(!existsSync("/bin/zsh"))(
  "isolated terminals run private zsh startup files and never read inherited ZDOTDIR",
  async ({ onTestFinished }) => {
    const { protectedHome, safeHome } = await testHomes(onTestFinished);
    const marker = join(protectedHome, "startup-read");
    await writeFile(join(protectedHome, ".zshenv"), `printf read > ${quote(marker)}\n`);
    await writeFile(join(safeHome, ".zshenv"), "printf 'PRIVATE_STARTUP\\n'\n");
    const env = testHomeEnvironment(safeHome, protectedHome, {
      ...process.env,
      ZDOTDIR: protectedHome,
    });
    const manager = new TerminalManager({ graceMs: 0 });
    onTestFinished(() => manager.closeAll());
    const terminal = manager.openTerminal({
      cwd: safeHome,
      shell: "/bin/zsh",
      env,
      cols: 80,
      rows: 24,
      name: "isolated",
    });
    const attachment = terminal.attach();
    onTestFinished(() => {
      attachment.detach();
    });
    const output = (async () => {
      let data = "";
      for await (const event of attachment) if (event.type === "data") data += event.data;
      return data;
    })();
    terminal.write("printf 'ISOLATED_COMMAND\\n'; exit\r");
    expect(await output).toContain("PRIVATE_STARTUP");
    expect(await terminal.exited).toEqual({ code: 0, signal: null });
    expect(await readdir(protectedHome)).toEqual([".zshenv"]);
  },
);
