import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { DoctorReport } from "@ace/diagnostics";
import { DeviceCredential, PairingResponse } from "@ace/protocol";
import { nodeBinary } from "@ace/provider-kit/testing";
import { accessRequest, redeemPairing } from "./client-access.ts";
import { lanAddress, refusesTcp } from "./network-test-support.ts";
import { scanTerminalQr } from "./qr-test-support.ts";
import { readConfig } from "./config.ts";
import { startDaemon } from "./index.ts";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
function home(): string {
  const directory = mkdtempSync(join(tmpdir(), "ace-cli-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const envFor = (directory: string) => ({
  ...process.env,
  ACE_HOME: directory,
  ACE_PORT: "0",
  ACE_LISTEN: "lan",
  ACE_ADVERTISE_HOST: "127.0.0.1",
  ACE_LOG_LEVEL: "silent",
});
const cli = (directory: string, args: string[], env: NodeJS.ProcessEnv = envFor(directory)) =>
  promisify(execFile)(process.execPath, [cliPath, ...args], { env });
it("starts in the foreground and exposes status, a redeemable QR URL, device listing and revocation through the CLI", async () => {
  const directory = home();
  const child = spawn(process.execPath, [cliPath, "start"], {
    env: envFor(directory),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "close");
  let output = "";
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += String(data);
  });
  const ready = new Promise<void>((resolve) => {
    child.stdout.on("data", (data) => {
      output += String(data);
      if (output.includes("Public-key SHA-256:")) resolve();
    });
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await Promise.race([
    ready,
    exited.then(() => {
      throw new Error(errors);
    }),
  ]);
  expect(output).toContain("ace daemon: ws://127.0.0.1:");
  const status = JSON.parse((await cli(directory, ["status"])).stdout);
  expect(status).toMatchObject({
    running: true,
    remote: { origin: expect.stringMatching(/^https:/) },
  });
  const pairing = (await cli(directory, ["pair", "read"])).stdout;
  const url = pairing.split("\n")[0];
  if (!url) throw new Error("Missing pairing URL");
  expect(pairing).toContain("Valid for 5 minutes, single use");
  expect(pairing).toContain("\u001b[30;47m");
  expect(scanTerminalQr(pairing)).toBe(url);
  const paired = await redeemPairing(url, "Phone");
  expect(paired.device.scopes).toEqual(["read"]);
  expect(JSON.parse((await cli(directory, ["devices", "list"])).stdout)).toMatchObject([
    { id: paired.device.id, name: "Phone", revokedAt: null },
  ]);
  expect(
    JSON.parse((await cli(directory, ["devices", "revoke", paired.device.id])).stdout),
  ).toEqual({ revoked: true });
  expect(JSON.parse((await cli(directory, ["devices", "list"])).stdout)).toMatchObject([
    { id: paired.device.id, revokedAt: expect.any(Number) },
  ]);
  child.kill("SIGTERM");
  expect((await exited)[0]).toBe(0);
  expect(JSON.parse((await cli(directory, ["status"])).stdout)).toEqual({ running: false });
});
it("doctor reuses provider-kit discovery with controlled CLI binaries and never sends prompts", async () => {
  const directory = home();
  const calls = join(directory, "calls");
  await nodeBinary(
    directory,
    "codex",
    `const { appendFileSync } = require('node:fs');\nconst args = process.argv.slice(2).join(' ');\nappendFileSync(${JSON.stringify(calls)}, args + '\\n');\nif (args === '--version') console.log('codex-cli 1.2.3');\nelse if (args === 'login status') console.log('Logged in using ChatGPT');\nelse process.exit(9);`,
  );
  let stdout = "";
  try {
    stdout = (await cli(directory, ["doctor", "--json"], { ...envFor(directory), PATH: directory }))
      .stdout;
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string")
      stdout = error.stdout;
    else throw error;
  }
  const result = DoctorReport.parse(JSON.parse(stdout));
  expect(result.checks.find((check) => check.id === "provider.codex")).toMatchObject({
    status: "ok",
    message: expect.stringContaining("1.2.3, logged_in"),
  });
  expect(result.checks.find((check) => check.id === "provider.claude")).toMatchObject({
    status: "warn",
    message: expect.stringContaining("not installed"),
  });
  expect(result.checks.find((check) => check.id === "remote.openssl")).toMatchObject({
    status: "fail",
  });
  expect(readFileSync(calls, "utf8").trim().split("\n").toSorted()).toEqual([
    "--version",
    "login status",
  ]);
});
it("binds the address discovered from a real Tailscale status process", async () => {
  const directory = home();
  const calls = join(directory, "calls");
  await nodeBinary(
    directory,
    "tailscale",
    `const { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' '));\nconsole.log(JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['127.0.0.1'] }));`,
  );
  // The daemon process gets a controlled PATH; OpenSSL remains available for TLS signing.
  const environment = {
    ...envFor(directory),
    ACE_LISTEN: "tailscale",
    PATH: `${directory}:${process.env.PATH}`,
  };
  const child = spawn(process.execPath, [cliPath, "start"], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "close");
  let output = "";
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += String(data);
  });
  const ready = new Promise<void>((resolve) => {
    child.stdout.on("data", (data) => {
      output += String(data);
      if (output.includes("Public-key SHA-256:")) resolve();
    });
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await Promise.race([
    ready,
    exited.then(() => {
      throw new Error(errors);
    }),
  ]);
  expect(readFileSync(calls, "utf8")).toBe("status --json");
  expect(output).toMatch(/Remote: wss:\/\/127\.0\.0\.1:\d+/);
  const token = readFileSync(join(directory, "daemon-token"), "utf8");
  const origin = readFileSync(join(directory, "daemon-endpoint"), "utf8");
  const pairing = PairingResponse.parse(
    await accessRequest(origin, "/v1/pairings", { method: "POST", token, body: {} }),
  );
  await expect(
    refusesTcp(lanAddress(), Number(new URL(pairing.url).port)),
  ).resolves.toBeUndefined();
  expect(
    DeviceCredential.parse(await redeemPairing(pairing.url, "Tailnet phone")).device.name,
  ).toBe("Tailnet phone");
  child.kill("SIGTERM");
  expect((await exited)[0]).toBe(0);
});
it("prints actionable Tailscale setup guidance without silently exposing the LAN", async () => {
  const directory = home();
  await nodeBinary(
    directory,
    "tailscale",
    `console.log(JSON.stringify({ BackendState: 'Stopped', TailscaleIPs: [] }));`,
  );
  await expect(
    cli(directory, ["start"], { ...envFor(directory), ACE_LISTEN: "tailscale", PATH: directory }),
  ).rejects.toThrow("tailscale serve");
  // A failed network setup releases the startup lock.
  const daemon = await startDaemon(
    readConfig({ ACE_HOME: directory, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
  );
  cleanups.push(() => daemon.close());
  expect(daemon.remoteUrl).toBeUndefined();
});
