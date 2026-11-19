import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProviderStatuses } from "./provider-status.ts";

test("provider statuses probe no CLI until the daemon's PATH is final, and show a check under way meanwhile", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-provider-path-"));
  // codex is only on the login shell's PATH, not on the one saved last launch.
  const login = join(home, "login-bin");
  await mkdir(login);
  await writeFile(join(login, "codex"), "");
  await chmod(join(login, "codex"), 0o755);
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: join(home, "saved-bin") };
  const pathReady = Promise.withResolvers<void>();
  const probed: string[] = [];
  const subject = new ProviderStatuses(
    {
      env,
      pathReady: pathReady.promise,
      probe: async (command, args) => {
        probed.push(command);
        return {
          code: 0,
          stderr: "",
          stdout: args[0] === "--version" ? "codex-cli 0.200.0" : "Logged in using ChatGPT",
        };
      },
      cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "unused" }),
      antigravity: async () => ({ installed: false, auth: "unknown", loginHint: "unused" }),
    },
    { now: () => 1_000, schedule: () => () => {} },
  );
  try {
    await new Promise((settle) => setImmediate(settle));
    expect(probed).toEqual([]);
    expect(subject.list().every((row) => row.refreshing)).toBe(true);
    // The daemon's copies take the login shell's PATH, then `final` settles.
    env.PATH = login;
    pathReady.resolve();
    await subject.firstCheck();
    await expect.poll(() => subject.list().every((row) => !row.refreshing)).toBe(true);
    expect(probed.length).toBeGreaterThan(0);
    expect(subject.list().find((row) => row.provider === "codex")).toMatchObject({
      installed: true,
    });
  } finally {
    await subject.close();
    await rm(home, { recursive: true, force: true });
  }
});
