import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { systemScheduler } from "../runtime.ts";
import { HelperConnection } from "./helper-connection.ts";

const fake = fileURLToPath(new URL("./testing/fake-computer-helper.ts", import.meta.url));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function connection() {
  const dir = await mkdtemp(join(tmpdir(), "ace-helper-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "ops.log");
  const children: ChildProcessWithoutNullStreams[] = [];
  let next = 0;
  const helper = new HelperConnection({
    start: async () => {
      const child = spawn(process.execPath, [fake, "--computer"], {
        env: { ...process.env, FAKE_LOG: log },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      return child;
    },
    nextId: () => `r${++next}`,
    scheduler: systemScheduler,
    maxReplyBytes: 1024 * 1024,
    graceMs: 300,
    idle: () => {},
  });
  cleanups.push(() => helper.close());
  const ops = async () =>
    (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { helper, children, ops };
}

it("a request whose signal was aborted before it was sent never reaches the helper", async () => {
  const { helper, children, ops } = await connection();
  const stop = new AbortController();
  stop.abort();
  const acting = helper.request(
    "act",
    { app: "com.apple.calculator", actions: [{ type: "key", key: "Escape" }] },
    10_000,
    stop.signal,
  );
  await expect(acting).rejects.toMatchObject({ code: "cancelled" });
  expect(helper.busy()).toBe(false);
  // The next request runs normally, and the helper only ever saw that one.
  await helper.request("state", { app: "com.apple.calculator" }, 10_000, undefined);
  expect(await ops()).toEqual(["state com.apple.calculator"]);
  expect(children).toHaveLength(1);
});
