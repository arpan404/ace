import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { checkBrowserEngine } from "./engine-check.ts";
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

/** A data directory and a stand-in Chromium whose behaviour is the shell `body`. */
async function chromium(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "ace-engine-check-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "chrome");
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { dataDir: join(dir, "data"), path };
}
const version = 'if [ "$1" = --version ]; then echo "Chromium 153.0.8010.12"; exit 0; fi';
const check = (dataDir: string, env: NodeJS.ProcessEnv) =>
  checkBrowserEngine({ dataDir, env, signal: new AbortController().signal, machine: ubuntu });

describe("ace doctor's browser check", () => {
  it("names the missing libraries and the install command when Chrome cannot load", async () => {
    const fake = await chromium(
      `echo "chrome: error while loading shared libraries: libnss3.so: cannot open shared object file" >&2; exit 127`,
    );
    const verdict = await check(fake.dataDir, { ACE_CHROMIUM_PATH: fake.path });
    expect(verdict.status).toBe("fail");
    expect(verdict.message).toMatch(/missing libnss3\.so, libgbm\.so\.1/);
    expect(verdict.fix).toBe("Install them: sudo apt-get install -y libnss3 libgbm1");
  });

  it("gives the AppArmor profile for the executable ace runs when the sandbox is blocked", async () => {
    const fake = await chromium(
      `${version}\necho "[1:1:FATAL:zygote_host_impl_linux.cc(129)] No usable sandbox!" >&2; exit 134`,
    );
    const verdict = await check(fake.dataDir, { ACE_CHROMIUM_PATH: fake.path });
    expect(verdict.status).toBe("fail");
    expect(verdict.message).toMatch(/AppArmor/);
    expect(verdict.fix).toContain("sudo tee /etc/apparmor.d/ace-chromium");
    expect(verdict.fix).toContain(`profile ace-chromium ${fake.path} flags=(unconfined)`);
    expect(verdict.fix).toContain("ACE_CHROMIUM_NO_SANDBOX=1");
  });

  it("passes a Chromium that starts headless, and warns when it runs without its sandbox", async () => {
    // Prints a page only when started headless; says whether the sandbox was turned off.
    const fake = await chromium(
      `${version}\ncase "$*" in *--headless=new*) ;; *) exit 1;; esac\ncase "$*" in *--no-sandbox*) echo nosandbox >&2;; esac\necho "<html><head></head><body></body></html>"`,
    );
    const sandboxed = await check(fake.dataDir, { ACE_CHROMIUM_PATH: fake.path });
    expect(sandboxed).toMatchObject({ status: "ok" });
    expect(sandboxed.message).toBe("Chromium 153.0.8010.12 starts headless with its sandbox");
    const unsandboxed = await check(fake.dataDir, {
      ACE_CHROMIUM_PATH: fake.path,
      ACE_CHROMIUM_NO_SANDBOX: "1",
    });
    expect(unsandboxed.status).toBe("warn");
    expect(unsandboxed.message).toMatch(/without its sandbox/);
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
