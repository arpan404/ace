import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, readConfig } from "./index.ts";
import { Client } from "./socket-test-support.ts";
import { once } from "node:events";
import { Command, DeviceId } from "@ace/protocol";
import { writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ace-doctor-cli-"));
  roots.push(root);
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  return {
    root,
    dataDir,
    env: {
      ...process.env,
      ACE_HOME: dataDir,
      ACE_PORT: "0",
      PATH: "",
      ACE_PRIVATE_TEST: "private-environment-string",
    },
  };
}
it("ace doctor emits JSON and fix hints without opening a writable database or starting a daemon", async () => {
  const { dataDir, env } = await setup();
  let stdout = "";
  try {
    const result = await exec(
      process.execPath,
      [fileURLToPath(new URL("./cli.ts", import.meta.url)), "doctor", "--json"],
      { env },
    );
    stdout = result.stdout;
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string")
      stdout = error.stdout;
    else throw error;
  }
  const report = JSON.parse(stdout);
  expect(
    report.checks.find((check: { id: string }) => check.id === "provider.codex"),
  ).toMatchObject({ status: "warn" });
  expect(report.checks.find((check: { id: string }) => check.id === "git")).toMatchObject({
    status: "fail",
    fix: "Install git and add it to PATH.",
  });
  expect(await readdir(dataDir)).toEqual([]);
  expect(stdout).not.toContain("private-environment-string");
});
it("ace support-bundle creates an archive and refuses to overwrite an existing output", async () => {
  const { root, env } = await setup();
  const path = join(root, "support.tar.gz");
  const args = [fileURLToPath(new URL("./cli.ts", import.meta.url)), "support-bundle", path];
  const first = await exec(process.execPath, args, { env });
  expect(first.stdout).toContain("Support bundle:");
  const bytes = await readFile(path);
  expect(bytes[0]).toBe(0x1f);
  expect(bytes[1]).toBe(0x8b);
  await expect(exec(process.execPath, args, { env })).rejects.toThrow();
  expect(await readFile(path)).toEqual(bytes);
});

it("an unavailable log directory does not prevent daemon operation and health counts the failed writes", async () => {
  const { dataDir } = await setup();
  await writeFile(join(dataDir, "logs"), "blocking file");
  const daemon = await startDaemon(readConfig({ ACE_HOME: dataDir, ACE_PORT: "0" }));
  const client = new Client(daemon.url);
  try {
    await once(client.socket, "open");
    const token = await readFile(daemon.tokenPath, "utf8");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("diagnostics-test"),
      token,
    });
    await client.next();
    client.send({
      type: "command",
      command: Command.parse({
        id: "failure-health",
        deviceId: "diagnostics-test",
        payload: { type: "diagnostics.health" },
      }),
    });
    const response = await client.next();
    if (response.type !== "commandResult" || !response.health) throw new Error("Missing health");
    expect(response.ok).toBe(true);
    expect(response.health.logs.failed).toBeGreaterThan(0);
    expect(daemon.store.createWorkspace("/diagnostics-test", "Test")).toBeTruthy();
  } finally {
    await client.close();
    await daemon.close();
  }
});
