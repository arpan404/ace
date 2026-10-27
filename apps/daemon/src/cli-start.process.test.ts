import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDaemonHome } from "@ace/service";
import { afterEach, expect, it } from "vitest";
import { exitCodes } from "./cli/output.ts";
import { acquireLock } from "./local-files.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function tempHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** Runs `ace start` against `home` and resolves with its exit code and stderr. */
async function aceStart(home: string, port: number) {
  const child = spawn(process.execPath, [new URL("./cli.ts", import.meta.url).pathname, "start"], {
    env: {
      ...process.env,
      ACE_HOME: home,
      ACE_PORT: String(port),
      ACE_LISTEN: "local",
      ACE_LOG_LEVEL: "silent",
      ACE_MAINTENANCE: "0",
      ACE_ACCOUNTS_DB: join(home, "accounts.sqlite"),
      ACE_DEV: "0",
      ACE_HISTORY_INSTANCES: "[]",
      ACE_MODEL_INSTANCES: "[]",
      ACE_APNS_KEY_FILE: "",
      ACE_VAPID_KEY_FILE: "",
      ACE_WORKSPACE_ROOT: "",
      ACE_RELAY_URL: undefined,
      ACE_SCREEN_HELPER: undefined,
      // No installed provider CLI is needed.
      PATH: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, stderr };
}

it("ace start exits with its own code when another process holds its port", async () => {
  const holder = createServer();
  holder.listen(0, "127.0.0.1");
  await once(holder, "listening");
  cleanups.push(() => new Promise<void>((resolve) => holder.close(() => resolve())));
  const { port } = holder.address() as AddressInfo;
  const home = await tempHome("ace-start-port-");

  const { code, stderr } = await aceStart(home, port);
  expect(stderr).toContain("EADDRINUSE");
  expect(code).toBe(exitCodes["address-in-use"]);
}, 60_000);

it("ace start exits with its own code when another daemon holds the home's lock", async () => {
  const home = await tempHome("ace-start-lock-");
  // A home in this build's format, so the start gets as far as the lock.
  prepareDaemonHome(home);
  const release = acquireLock(home);
  cleanups.push(async () => release());

  const { code, stderr } = await aceStart(home, 0);
  expect(stderr).toContain("Another daemon owns it");
  expect(code).toBe(exitCodes["lock-held"]);
}, 60_000);
