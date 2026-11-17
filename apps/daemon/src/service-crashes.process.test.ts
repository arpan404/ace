// A process test: the crash must be on disk before the process dies, which only a real process
// death shows. The skip rules themselves are table-tested in service-crashes.test.ts.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { attemptFile, safeModeSkips } from "./startup-attempts.ts";
import { crashRecord, repeatedCrashes } from "./service-crashes.ts";
import { serviceOrder } from "./services/service-order.ts";
import { bunBinary, realNode } from "../../../scripts/runtimes.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const source = (path: string) => JSON.stringify(join(import.meta.dirname, path));

/** A daemon-shaped process: the same scope, listeners and record as `startDaemon` installs. */
async function crashingProcess(root: string): Promise<string> {
  const script = join(root, "crash.ts");
  await writeFile(
    script,
    `import { ServiceScope } from ${source("services/service-scope.ts")};
import { crashRecord, installCrashAttribution } from ${source("service-crashes.ts")};
import { attemptFile } from ${source("startup-attempts.ts")};
import { installRejectionGuard } from ${source("fatal-log.ts")};
const [file, how] = process.argv.slice(2);
const scope = new ServiceScope();
const crashes = crashRecord(attemptFile(file));
installCrashAttribution(process, () => scope.current(), (service) => crashes.record(service, Date.now()));
installRejectionGuard(process, { log() {} }, () => false);
// Command discovery, still running after the daemon listens, fails nobody catches.
scope.run("commands", () =>
  setTimeout(() => {
    if (how === "throw") throw new Error("discovery failed");
    void Promise.reject(new Error("discovery failed"));
  }, 5),
);
setTimeout(() => {}, 1_000);
`,
  );
  return script;
}

async function crashTwice(runtime: string, how: "throw" | "reject") {
  const root = await mkdtemp(join(tmpdir(), "ace-service-crash-"));
  roots.push(root);
  const script = await crashingProcess(root);
  const file = join(root, "service-crashes.json");
  for (let run = 0; run < 2; run++) {
    const child = spawnSync(runtime, [script, file, how], { encoding: "utf8", timeout: 20_000 });
    expect(child.status).not.toBe(0);
  }
  return safeModeSkips(
    [],
    serviceOrder,
    repeatedCrashes(crashRecord(attemptFile(file)).previous, Date.now()),
  );
}

test("a service whose background work throws after listening, twice, is left off by the next safe-mode start", async () => {
  // Bun is the runtime releases ship the daemon on.
  expect(await crashTwice(bunBinary(), "throw")).toEqual(["commands"]);
});

test("on Node, a service whose background work rejects unhandled, twice, is left off too", async () => {
  // Bun gives an unhandledRejection listener no async context, so there it goes unattributed.
  const node = realNode();
  if (!node) throw new Error("Node must be on PATH for this test");
  expect(await crashTwice(node, "reject")).toEqual(["commands"]);
});
