import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkBrowserEngine, engineExecutable } from "@ace/browser/engine-check";
import { expect, onTestFinished, test } from "vitest";
import { appProfile, browserProfile, linuxInstall } from "./linux-sandbox.ts";
import { setupScript } from "./linux-sandbox-setup.ts";

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ace-sandbox-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("the setup installs exactly the profile ace doctor prints when AppArmor blocks Chrome", async () => {
  const dataDir = join(await scratch(), "ace home");
  // A Chrome that fails the way a blocked sandbox does, at the path the daemon would run.
  const chrome = engineExecutable({ dataDir, env: {}, platform: "linux", arch: "x64" }).path;
  await mkdir(dirname(chrome), { recursive: true });
  await writeFile(
    chrome,
    "#!/bin/sh\necho 'FATAL:zygote_host_impl_linux.cc No usable sandbox!' >&2\nexit 1\n",
  );
  await chmod(chrome, 0o755);
  const verdict = await checkBrowserEngine({
    dataDir,
    env: {},
    signal: AbortSignal.timeout(10_000),
    platform: "linux",
    arch: "x64",
    home: "/home/me",
    machine: {
      readText: async (path) =>
        path === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns" ? "1\n" : undefined,
      ldd: async () => undefined,
      root: false,
    },
  });
  expect(verdict.message).toMatch(/AppArmor restricts user namespaces/);
  const desktop = browserProfile({ dataDir, home: "/home/me" });
  expect(verdict.fix).toContain(`sudo tee /etc/apparmor.d/${desktop.name} >/dev/null <<'EOF'\n`);
  expect(verdict.fix).toContain(`${desktop.text.trimEnd()}\nEOF\n`);
});

test("the root side refuses a profile name outside ace's own before writing anything", () => {
  for (const name of ["../../etc/passwd", "ace-x/../../etc/passwd", "ace-", "chrome", "ace-A"]) {
    const run = spawnSync("/bin/sh", ["-c", setupScript, "ace-sandbox-setup", name, "text"], {
      encoding: "utf8",
    });
    expect({ name, status: run.status }).toEqual({ name, status: 64 });
  }
});

const parser = spawnSync("apparmor_parser", ["--version"]).status === 0;
test.skipIf(!parser)(
  "AppArmor accepts the app's profile for AppImage and tar.gz paths with awkward characters",
  async () => {
    const dir = await scratch();
    for (const install of [
      linuxInstall({ APPIMAGE: "/home/me/My Apps, {old}/ace-1.0.0-arm64.AppImage" }, "/tmp/x"),
      linuxInstall({ APPIMAGE: "/home/me/Apps/ace.AppImage" }, "/tmp/x"),
      linuxInstall({}, "/home/me/ace [2]/ace-desktop-bin"),
    ]) {
      const profile = appProfile(install, 1000);
      if (!profile) throw new Error("no profile");
      const file = join(dir, profile.name);
      await writeFile(file, profile.text);
      const run = spawnSync("apparmor_parser", ["-QK", "-d", file], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(`${run.stdout}\n${run.stderr}`).toMatch(/Mode:\s+unconfined/);
    }
  },
);
