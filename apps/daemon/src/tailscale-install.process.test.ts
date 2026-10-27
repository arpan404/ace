import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readConfig } from "./config.ts";
import { remoteAccessPorts } from "./doctor/remote-access-facts.ts";
import { doctorTestContext } from "./doctor/test-support.ts";
import { remoteListener, systemNetwork } from "./network.ts";
import { findTailscaleExe } from "./tailscale-command.ts";
import { trustedCertificate } from "./tailscale-certificate.ts";

/*
 * Windows only: Tailscale isn't on the CI runners, so `tailscale.exe` here is a copy of node.exe
 * that a preloaded script turns into a fake. It answers `status` from the `status.json` beside it
 * and echoes `cert`'s arguments, so each test can tell which copy ran and what it was asked.
 */
const fake = String.raw`
const { basename, dirname, join } = require("node:path");
const { readFileSync } = require("node:fs");
if (basename(process.execPath).toLowerCase() === "tailscale.exe") {
  const [script = "", ...rest] = process.argv.slice(1);
  const command = basename(script);
  if (command === "status") process.stdout.write(readFileSync(join(dirname(process.execPath), "status.json")));
  else process.stdout.write(JSON.stringify([command, ...rest]));
  process.exit(0);
}
`;

const windows = process.platform === "win32";
let root = "";
let saved: Record<string, string | undefined> = {};

async function install(directory: string, address: string) {
  await mkdir(directory, { recursive: true });
  await copyFile(process.execPath, join(directory, "tailscale.exe"));
  await writeFile(
    join(directory, "status.json"),
    JSON.stringify({
      BackendState: "Running",
      TailscaleIPs: [address, "fd7a:115c:a1e0::1"],
      Self: { DNSName: "winbox.example.ts.net." },
      CurrentTailnet: { MagicDNSEnabled: true },
    }),
  );
}

const identity = () => ({ key: Buffer.from(""), cert: Buffer.from(""), fingerprint: "pin" });
const config = () => readConfig({ ACE_HOME: join(root, "home"), ACE_LISTEN: "tailscale" }, root);

describe.runIf(windows)("Tailscale on Windows", () => {
  beforeAll(async () => {
    saved = Object.fromEntries(
      ["PATH", "ProgramFiles", "ProgramW6432", "NODE_OPTIONS"].map((key) => [
        key,
        process.env[key],
      ]),
    );
    root = await mkdtemp(join(tmpdir(), "ace-tailscale-"));
    const preload = join(root, "fake-tailscale.cjs");
    await writeFile(preload, fake);
    // NODE_OPTIONS reads backslashes inside quotes as escapes; forward slashes keep the path.
    process.env.NODE_OPTIONS = `--require "${preload.replaceAll("\\", "/")}"`;
    // A folder with a space, like the real "C:\Program Files".
    process.env.ProgramFiles = join(root, "Program Files");
    process.env.ProgramW6432 = join(root, "Program Files");
    await install(join(root, "Program Files", "Tailscale"), "100.64.0.7");
    await install(join(root, "on-path"), "100.64.0.9");
    // A batch file is never a Tailscale: execFile can't start one.
    await mkdir(join(root, "batch"));
    await writeFile(join(root, "batch", "tailscale.cmd"), "@echo off\r\nexit /b 0\r\n");
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    // A just-run copy of node.exe can stay locked briefly (EBUSY) while Windows releases it.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it("remote access over Tailscale uses its install folder when PATH doesn't have it", async () => {
    process.env.PATH = dirname(process.execPath);
    const listener = await remoteListener(config(), { ...systemNetwork, identity });
    expect(listener).toMatchObject({
      host: "100.64.0.7",
      advertisedHost: "100.64.0.7",
      tailnetName: "winbox.example.ts.net",
    });
  });

  it("a tailscale.exe planted earlier on PATH never stands in for the installed one", async () => {
    process.env.PATH = [join(root, "on-path"), dirname(process.execPath)].join(";");
    expect(await findTailscaleExe(process.env)).toBe(
      join(root, "Program Files", "Tailscale", "tailscale.exe"),
    );
    const listener = await remoteListener(config(), { ...systemNetwork, identity });
    expect(listener?.host).toBe("100.64.0.7");
  });

  it("without the install, only a tailscale.exe in a local absolute PATH folder is used", async () => {
    const env = {
      ProgramFiles: join(root, "nowhere"),
      ProgramW6432: join(root, "nowhere"),
      // Relative, rooted and network-share folders and a batch file never count.
      PATH: ["on-path", "\\on-path", "\\\\server\\share", join(root, "batch")].join(";"),
    };
    expect(await findTailscaleExe(env)).toBeUndefined();
    expect(await findTailscaleExe({ ...env, PATH: `${env.PATH};${join(root, "on-path")}` })).toBe(
      join(root, "on-path", "tailscale.exe"),
    );
  });

  it("the certificate is fetched to stdout for the machine's ts.net name", async () => {
    process.env.PATH = dirname(process.execPath);
    const output = await systemNetwork.certificate("winbox.example.ts.net");
    expect(JSON.parse(output)).toEqual([
      "cert",
      "--cert-file",
      "-",
      "--key-file",
      "-",
      "--",
      "winbox.example.ts.net",
    ]);
  });

  it("with no tailscale.exe anywhere, nothing runs and remote access says Tailscale isn't installed", async () => {
    // The daemon's working folder holds a tailscale.exe; a bare-name lookup would run it.
    const cwd = process.cwd();
    process.chdir(join(root, "on-path"));
    process.env.PATH = [join(root, "batch"), dirname(process.execPath)].join(";");
    process.env.ProgramFiles = join(root, "nowhere");
    process.env.ProgramW6432 = join(root, "nowhere");
    try {
      const failure = await remoteListener(config(), { ...systemNetwork, identity }).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        message: expect.stringMatching(/Cannot detect Tailscale address/),
        cause: expect.objectContaining({
          message: expect.stringMatching(/Tailscale isn't installed/),
        }),
      });
    } finally {
      process.chdir(cwd);
      process.env.ProgramFiles = join(root, "Program Files");
      process.env.ProgramW6432 = join(root, "Program Files");
    }
  });

  it("doctor finds the installed Tailscale exactly as the daemon does", async () => {
    const { context, cleanup } = await doctorTestContext({
      env: { PATH: join(root, "on-path"), ProgramFiles: join(root, "Program Files") },
    });
    try {
      expect(await remoteAccessPorts.tailscale(context)).toBe(
        join(root, "Program Files", "Tailscale", "tailscale.exe"),
      );
      expect(
        await remoteAccessPorts.tailscale({
          ...context,
          env: { PATH: join(root, "batch"), ProgramFiles: join(root, "nowhere") },
        }),
      ).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("a refused certificate fetch asks to connect Tailscale from this Windows account, never sudo", async () => {
    const logged: Error[] = [];
    const certificate = trustedCertificate({
      name: "winbox.example.ts.net",
      fetch: async () => {
        throw new Error("Access denied: cert access denied");
      },
      now: () => 0,
      delay: () => () => {},
      log: (error) => logged.push(error),
    });
    await certificate.ready;
    certificate.stop();
    expect(certificate.active()).toBe(false);
    expect(logged.map((error) => error.message)).toEqual([
      expect.stringContaining("Connect Tailscale from this Windows account"),
    ]);
    expect(logged[0]?.message).not.toContain("sudo");
  });
});
