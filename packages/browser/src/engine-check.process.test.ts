import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { browserEngineRepairs, checkBrowserEngine } from "./engine-check.ts";
import type { LinuxMachine } from "./launch-diagnosis.ts";
import { executablePath } from "./test-support.ts";

const ubuntu: LinuxMachine = {
  readText: async (path) =>
    ({
      "/etc/os-release": "ID=ubuntu\nID_LIKE=debian\n",
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
    })[path],
  ldd: async () => "\tlibnss3.so => not found\n\tlibgbm.so.1 => not found\n",
  root: false,
};
/** Arch's kernel: user namespaces allowed through its clone switch, no AppArmor sysctl. */
const arch: LinuxMachine = {
  readText: async (path) =>
    ({
      "/etc/os-release": 'NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n',
      "/proc/sys/kernel/unprivileged_userns_clone": "1\n",
    })[path],
  ldd: async () => undefined,
  root: false,
};

/** A data directory and a stand-in Chromium whose behaviour is the shell `body`. */
async function chromium(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "ace-engine-check-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "chrome");
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { dataDir: join(dir, "data"), path };
}
/**
 * A stand-in that speaks Chrome's debugging pipe (NUL-separated JSON on fds 3 and 4): it answers
 * every command, exits on `Browser.close`, and records its arguments for the test.
 */
async function pipeChromium() {
  const fake = await chromium("exit 1");
  const argv = `${fake.path}.argv`;
  const script = `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("Chromium 153.0.8010.12"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argv)}, process.argv.join(" "));
if (!process.argv.includes("--headless=new") || !process.argv.includes("--remote-debugging-pipe")) process.exit(1);
const output = fs.createWriteStream(null, { fd: 4 });
let pending = "";
fs.createReadStream(null, { fd: 3 }).on("data", (chunk) => {
  const messages = (pending + chunk).split("\\0");
  pending = messages.pop();
  for (const message of messages) {
    const { id, method } = JSON.parse(message);
    if (method === "Browser.close") process.exit(0);
    output.write(JSON.stringify({ id, result: {} }) + "\\0");
  }
});
`;
  await writeFile(fake.path, script, { mode: 0o755 });
  return { ...fake, argv };
}
const version = 'if [ "$1" = --version ]; then echo "Chromium 153.0.8010.12"; exit 0; fi';
const check = (dataDir: string, env: NodeJS.ProcessEnv) =>
  checkBrowserEngine({ dataDir, env, signal: new AbortController().signal, machine: ubuntu });
const repairs = (dataDir: string, env: NodeJS.ProcessEnv, machine: LinuxMachine = ubuntu) =>
  browserEngineRepairs({
    dataDir,
    env,
    signal: new AbortController().signal,
    platform: "linux",
    machine,
  });

describe("ace doctor's browser check", () => {
  it("names the missing libraries and the install command when Chrome cannot load", async () => {
    const fake = await chromium(
      `echo "chrome: error while loading shared libraries: libnss3.so: cannot open shared object file" >&2; exit 127`,
    );
    const verdict = await check(fake.dataDir, { ACE_CHROMIUM_PATH: fake.path });
    expect(verdict.status).toBe("fail");
    expect(verdict.message).toMatch(/missing libnss3\.so, libgbm\.so\.1/);
    expect(verdict.fix).toBe(
      "Run ace doctor --fix to install them, or run: sudo apt-get install -y libnss3 libgbm1",
    );
    expect((await repairs(fake.dataDir, { ACE_CHROMIUM_PATH: fake.path })).packages).toEqual({
      libraries: ["libnss3.so", "libgbm.so.1"],
      install: "sudo apt-get install -y libnss3 libgbm1",
      steps: [
        ["apt-get", "update"],
        ["apt-get", "install", "-y", "libnss3", "libgbm1"],
      ],
    });
  });

  it("offers the AppArmor profile for the executable ace runs when the sandbox is blocked", async () => {
    const fake = await chromium(
      `${version}\necho "[1:1:FATAL:zygote_host_impl_linux.cc(129)] No usable sandbox!" >&2; exit 134`,
    );
    const env = { ACE_CHROMIUM_PATH: fake.path };
    const verdict = await check(fake.dataDir, env);
    expect(verdict.status).toBe("fail");
    expect(verdict.message).toMatch(/AppArmor/);
    expect(verdict.fix).toContain("ace doctor --fix");
    expect(verdict.fix).toContain("ACE_CHROMIUM_NO_SANDBOX=1");
    // The shared report never carries this machine's path; the repair does.
    expect(verdict.fix).not.toContain(fake.path);
    const { profile, packages } = await repairs(fake.dataDir, env);
    expect(packages).toBeUndefined();
    expect(profile?.name).toBe("ace-chromium");
    expect(profile?.text).toContain(`profile ace-chromium ${fake.path} flags=(unconfined)`);
  });

  it("offers no profile once the one ace needs is installed, or where AppArmor doesn't restrict", async () => {
    const fake = await chromium(
      `${version}\necho "[1:1:FATAL:zygote_host_impl_linux.cc(129)] No usable sandbox!" >&2; exit 134`,
    );
    const env = { ACE_CHROMIUM_PATH: fake.path };
    const wanted = (await repairs(fake.dataDir, env)).profile?.text;
    const installed: LinuxMachine = {
      ...ubuntu,
      readText: async (path) =>
        path === "/etc/apparmor.d/ace-chromium" ? wanted : ubuntu.readText(path),
    };
    expect(await repairs(fake.dataDir, env, installed)).toEqual({});
    expect(await repairs(fake.dataDir, env, arch)).toEqual({});
  });

  it("passes a Chromium that starts headless, and warns when it runs without its sandbox", async () => {
    const fake = await pipeChromium();
    const sandboxed = await check(fake.dataDir, { ACE_CHROMIUM_PATH: fake.path });
    expect(sandboxed).toMatchObject({ status: "ok" });
    expect(sandboxed.message).toBe("Chromium 153.0.8010.12 starts headless with its sandbox");
    expect(await readFile(fake.argv, "utf8")).not.toContain("--no-sandbox");
    const unsandboxed = await check(fake.dataDir, {
      ACE_CHROMIUM_PATH: fake.path,
      ACE_CHROMIUM_NO_SANDBOX: "1",
    });
    expect(unsandboxed.status).toBe("warn");
    expect(unsandboxed.message).toMatch(/without its sandbox/);
    expect(await readFile(fake.argv, "utf8")).toContain("--no-sandbox");
  });

  it("asks Ubuntu for the AppArmor profile but Arch only to drop the sandbox opt-out", async () => {
    const fake = await pipeChromium();
    const env = { ACE_CHROMIUM_PATH: fake.path, ACE_CHROMIUM_NO_SANDBOX: "1" };
    const onLinux = (machine: LinuxMachine) =>
      checkBrowserEngine({
        dataDir: fake.dataDir,
        env,
        signal: new AbortController().signal,
        platform: "linux",
        machine,
      });
    const onUbuntu = await onLinux(ubuntu);
    expect(onUbuntu.status).toBe("warn");
    expect(onUbuntu.fix).toMatch(/AppArmor profile.*ace doctor --fix/s);
    const onArch = await onLinux(arch);
    expect(onArch.status).toBe("warn");
    expect(onArch.fix).not.toMatch(/AppArmor|apparmor/);
    expect(onArch.fix).toMatch(/unset ACE_CHROMIUM_NO_SANDBOX/);
  });

  it("never offers an AppArmor profile for a blocked sandbox on a kernel without AppArmor", async () => {
    const fake = await chromium(
      `${version}\necho "[1:1:FATAL:zygote_host_impl_linux.cc(129)] No usable sandbox!" >&2; exit 134`,
    );
    const verdict = await checkBrowserEngine({
      dataDir: fake.dataDir,
      env: { ACE_CHROMIUM_PATH: fake.path },
      signal: new AbortController().signal,
      machine: arch,
    });
    expect(verdict.status).toBe("fail");
    expect(verdict.message).not.toMatch(/AppArmor/);
    expect(verdict.fix).not.toContain("apparmor");
  });

  it("fails a Chromium that starts but never opens a page", async () => {
    const fake = await chromium(
      `${version}\necho "[1:1:0/0:ERROR:gpu_init.cc(1)] GPU died" >&2; exit 1`,
    );
    const verdict = await check(fake.dataDir, { ACE_CHROMIUM_PATH: fake.path });
    expect(verdict.status).toBe("fail");
    expect(verdict.message).toBe("ace's browser did not start: ERROR gpu_init.cc(1): GPU died");
  });

  it("reports an override that is not an executable", async () => {
    const fake = await chromium("exit 0");
    const verdict = await check(fake.dataDir, { ACE_CHROMIUM_PATH: join(fake.dataDir, "none") });
    expect(verdict).toMatchObject({
      status: "fail",
      message: "ACE_CHROMIUM_PATH is not an executable file",
    });
  });

  it("says ace's Chrome downloads on first use before it has been downloaded", async () => {
    const fake = await chromium("exit 0");
    const verdict = await check(fake.dataDir, {});
    expect(verdict.status).toBe("ok");
    expect(verdict.message).toMatch(
      /^ace's Chrome 153\.0\.8010\.12 downloads on first browser use$/,
    );
  });

  it.skipIf(!executablePath)(
    "starts the real engine on this machine",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "ace-engine-real-"));
      onTestFinished(() => rm(dir, { recursive: true, force: true }));
      const verdict = await checkBrowserEngine({
        dataDir: dir,
        env: {
          ACE_CHROMIUM_PATH: executablePath,
          ACE_CHROMIUM_NO_SANDBOX: process.env.ACE_CHROMIUM_NO_SANDBOX,
        },
        signal: new AbortController().signal,
        timeoutMs: 20_000,
      });
      expect(verdict.message).toMatch(/starts headless/);
    },
    60_000,
  );
});

it.runIf(process.platform === "win32" && process.arch === "arm64")(
  "Windows ARM64: ace doctor checks the installed Chrome or Edge instead of a download that doesn't exist",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ace-engine-arm-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const { ACE_CHROMIUM_PATH: _named, ...env } = process.env;
    const verdict = await checkBrowserEngine({
      dataDir: dir,
      env,
      signal: new AbortController().signal,
      timeoutMs: 20_000,
    });
    expect(verdict).toMatchObject({ status: "ok" });
    // Named from its install folder ("chrome 156.0.4314.42"), never by opening a window.
    expect(verdict.message).toMatch(
      /^(chrome|msedge) \d+\.\d+\.\d+\.\d+ starts headless with its sandbox$/,
    );
  },
  60_000,
);

it.runIf(process.platform === "win32" && process.arch === "arm64")(
  "Windows ARM64: with no Chrome or Edge to run, ace doctor warns that the emulated x64 fallback runs with renderer code integrity off",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ace-engine-emulated-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    // No installed browser in this environment, and nothing downloaded yet.
    const verdict = await checkBrowserEngine({
      dataDir: dir,
      env: {},
      signal: new AbortController().signal,
      timeoutMs: 20_000,
    });
    expect(verdict.status).toBe("warn");
    expect(verdict.message).toMatch(/x64, under emulation.*renderer code integrity off/);
    expect(verdict.fix).toMatch(/Install Google Chrome or Microsoft Edge for ARM64/);
  },
  60_000,
);
