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

async function connection(
  extraEnv: Record<string, string> = {},
  /** Whether SIGKILL reaches the helpers; false stands in for a kill the system refuses. */
  killable = true,
) {
  const dir = await mkdtemp(join(tmpdir(), "ace-helper-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "ops.log");
  const children: ChildProcessWithoutNullStreams[] = [];
  const starts: boolean[] = [];
  let next = 0;
  const helper = new HelperConnection({
    start: async () => {
      const child = spawn(process.execPath, [fake, "--computer"], {
        env: { ...process.env, FAKE_LOG: log, ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Whether every earlier helper had already exited when this one was started.
      starts.push(
        children.every((earlier) => earlier.exitCode !== null || earlier.signalCode !== null),
      );
      children.push(child);
      const kill = child.kill.bind(child);
      cleanups.push(() => {
        kill("SIGKILL");
      });
      if (!killable)
        child.kill = (signal?: NodeJS.Signals | number) =>
          signal === "SIGKILL" ? false : kill(signal);
      return child;
    },
    nextId: () => `r${++next}`,
    scheduler: systemScheduler,
    maxReplyBytes: 1024 * 1024,
    graceMs: 300,
    forceKillMs: 300,
    idle: () => {},
  });
  cleanups.push(() => helper.close());
  const ops = async () =>
    (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { helper, children, starts, ops };
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

it("a helper whose stdin pipe breaks mid-request fails that request and the next one gets a fresh helper", async () => {
  const { helper, children } = await connection();
  const stuck = helper.request(
    "act",
    { app: "com.example.stuck", actions: [{ type: "key", key: "Escape" }] },
    10_000,
    undefined,
  );
  // Wait until the request is on the wire, then the pipe breaks as an exiting helper's would.
  while (children.length === 0 || !helper.busy()) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  const pipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  expect(() => children[0]?.stdin.emit("error", pipe)).not.toThrow();
  await expect(stuck).rejects.toMatchObject({ code: "helper_exited" });
  await helper.request("state", { app: "com.apple.calculator" }, 10_000, undefined);
  expect(children).toHaveLength(2);
});

it("a stuck helper that ignores SIGTERM is force-killed, and its replacement starts only after it exited", async () => {
  const { helper, children, starts, ops } = await connection({ FAKE_IGNORE_STOP: "1" });
  const stuck = helper.request(
    "act",
    { app: "com.example.stuck", actions: [{ type: "key", key: "Escape" }] },
    200,
    undefined,
  );
  // Queued behind the stuck request: it needs a new helper for the same app.
  const next = helper.request("state", { app: "com.apple.calculator" }, 10_000, undefined);
  await expect(stuck).rejects.toMatchObject({ code: "timeout" });
  await next;
  expect(children).toHaveLength(2);
  expect(starts).toEqual([true, true]);
  expect(children[0]?.signalCode).toBe("SIGKILL");
  // The old helper was asked to stop first, and given time to clean up.
  expect(await ops()).toContain("sigterm");
});

it("while a stopping helper can't be killed, the app's next request fails instead of starting another", async () => {
  const { helper, children } = await connection({ FAKE_IGNORE_STOP: "1" }, false);
  const stuck = helper.request(
    "act",
    { app: "com.example.stuck", actions: [{ type: "key", key: "Escape" }] },
    200,
    undefined,
  );
  const next = helper.request("state", { app: "com.apple.calculator" }, 10_000, undefined);
  await expect(stuck).rejects.toMatchObject({ code: "timeout" });
  await expect(next).rejects.toMatchObject({ code: "helper_stopping" });
  expect(children).toHaveLength(1);
  expect(children[0]?.exitCode).toBeNull();
  expect(children[0]?.signalCode).toBeNull();
});
