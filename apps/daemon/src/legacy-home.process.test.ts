import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, onTestFinished as cleanup } from "vitest";
import { readConfig } from "./config.ts";
import { serviceCommand } from "@ace/service";

async function legacy(home: string) {
  const root = join(home, ".ace");
  await mkdir(join(root, "bin"), { recursive: true, mode: 0o755 });
  await writeFile(
    join(root, "bin/ace"),
    `#!/bin/sh\necho executed > "${join(root, "executed")}"\nexit 99\n`,
    { mode: 0o755 },
  );
  await writeFile(join(root, "ace.db"), "legacy data must stay byte-for-byte intact");
  return root;
}

test("default home isolates a synthetic legacy installation without changing its data or permissions", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-legacy-home-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const old = await legacy(home);
  const before = await stat(old);
  const config = readConfig({}, home);
  expect(config.dataDir).toBe(join(home, ".ace-next"));
  expect(await readFile(join(config.dataDir, "legacy-home.json"), "utf8")).toContain("migration");
  expect(readConfig({}, home).dataDir).toBe(config.dataDir);
  expect(await readFile(join(old, "ace.db"), "utf8")).toBe(
    "legacy data must stay byte-for-byte intact",
  );
  expect((await stat(old)).mode).toBe(before.mode);
  expect((await readdir(old)).toSorted()).toEqual(["ace.db", "bin"]);
  await rm(old, { recursive: true });
  expect(readConfig({}, home).dataDir).toBe(config.dataDir);
});

test("an explicit legacy home is refused before opening or migrating data", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-legacy-explicit-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const old = await legacy(home);
  expect(() => readConfig({ ACE_HOME: old }, home)).toThrow(/incompatible|legacy/i);
  expect((await readdir(old)).toSorted()).toEqual(["ace.db", "bin"]);
});

test.each(["install", "start", "status", "stop", "uninstall"])(
  "legacy service %s is refused without executing its binary or contacting the service manager",
  async (action) => {
    const home = await mkdtemp(join(tmpdir(), "ace-legacy-service-"));
    cleanup(() => rm(home, { recursive: true, force: true }));
    const old = await legacy(home);
    await expect(serviceCommand(old, [action])).rejects.toThrow(/legacy|incompatible/i);
    await expect(readFile(join(old, "executed"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("ace status refuses a live legacy daemon instead of accepting its health response", async ({
  onTestFinished,
}) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { daemonCli } = await import("./process-test-support.ts");
  const root = await mkdtemp(join(tmpdir(), "ace-legacy-health-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ running: true, version: "0.9.8" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing health port");
  await writeFile(join(root, "daemon-endpoint"), `http://127.0.0.1:${address.port}`);
  await writeFile(join(root, "daemon-token"), "a".repeat(64));
  await expect(
    promisify(execFile)(process.execPath, [daemonCli(), "status"], {
      env: { ...process.env, ACE_HOME: root },
    }),
  ).rejects.toThrow(/Legacy ace 0.x/);
});

test("default isolation refuses to claim an already populated unrecognized next home", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-legacy-next-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  await legacy(home);
  const next = join(home, ".ace-next");
  await mkdir(next);
  await writeFile(join(next, "unknown-data"), "leave alone");
  expect(() => readConfig({}, home)).toThrow(/Unrecognized data/);
  expect(await readdir(next)).toEqual(["unknown-data"]);
});
