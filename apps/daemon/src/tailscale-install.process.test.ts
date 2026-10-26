import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readConfig } from "./config.ts";
import { remoteAccessPorts } from "./doctor/remote-access-facts.ts";
import { doctorTestContext } from "./doctor/test-support.ts";
import { findWindowsTailscale, remoteListener, systemNetwork } from "./network.ts";
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
const saved = {
  PATH: process.env.PATH,
  ProgramFiles: process.env.ProgramFiles,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
};

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
    root = await mkdtemp(join(tmpdir(), "ace-tailscale-"));
    const preload = join(root, "fake-tailscale.cjs");
    await writeFile(preload, fake);
    // NODE_OPTIONS reads backslashes inside quotes as escapes; forward slashes keep the path.
    process.env.NODE_OPTIONS = `--require "${preload.replaceAll("\\", "/")}"`;
    // A folder with a space, like the real "C:\Program Files".
    process.env.ProgramFiles = join(root, "Program Files");
    await install(join(root, "Program Files", "Tailscale"), "100.64.0.7");
    await install(join(root, "on-path"), "100.64.0.9");
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

  it("a tailscale.exe on PATH wins over the install folder", async () => {
    process.env.PATH = [join(root, "on-path"), dirname(process.execPath)].join(";");
    expect(await findWindowsTailscale(process.env)).toBe(join(root, "on-path", "tailscale.exe"));
    const listener = await remoteListener(config(), { ...systemNetwork, identity });
    expect(listener?.host).toBe("100.64.0.9");
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

  it("with Tailscale missing, remote access says how to start it", async () => {
    process.env.PATH = dirname(process.execPath);
    const programFiles = process.env.ProgramFiles;
    process.env.ProgramFiles = join(root, "nowhere");
    try {
      await expect(remoteListener(config(), { ...systemNetwork, identity })).rejects.toThrow(
        /Cannot detect Tailscale address/,
      );
    } finally {
      process.env.ProgramFiles = programFiles;
    }
  });

  it("doctor finds Tailscale in its install folder, as the daemon does", async () => {
    const { context, cleanup } = await doctorTestContext({
      env: { PATH: "", ProgramFiles: join(root, "Program Files") },
    });
    try {
      expect(await remoteAccessPorts.tailscale(context)).toBe(
        join(root, "Program Files", "Tailscale", "tailscale.exe"),
      );
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
