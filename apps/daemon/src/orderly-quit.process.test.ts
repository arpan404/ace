import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Worker } from "node:worker_threads";
import { launchDaemon } from "./process-test-support.ts";
import { startDaemon, readConfig } from "./index.ts";

test("orderly CLI quit leaves no notification failure in stderr or durable logs", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-smoke-quit-"));
  const cleanups: (() => Promise<void> | void)[] = [
    () => rm(home, { recursive: true, force: true }),
  ];
  onTestFinished(async () => {
    for (const close of cleanups.toReversed()) await close();
  });
  const { child, exited, ready } = launchDaemon(
    { ...process.env, ACE_HOME: home, ACE_PORT: "0", ACE_LISTEN: "local", PATH: "" },
    /Token file:/,
    cleanups,
  );
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  await ready;
  child.kill("SIGTERM");
  expect((await exited)[0]).toBe(0);
  const logs = (
    await Promise.all(
      (await readdir(join(home, "logs"))).map((name) => readFile(join(home, "logs", name), "utf8")),
    )
  ).join("\n");
  expect(stderr + logs).not.toMatch(
    /Notification worker aborted|Notification service failure|warmup failed/,
  );
});

test("a real notification worker failure remains visible in the durable daemon log", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-smoke-worker-failure-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
    notificationWorker: () =>
      new Worker('throw new Error("real notification failure")', { eval: true }),
  });
  await daemon.close();
  const logs = (
    await Promise.all(
      (await readdir(join(home, "logs"))).map((name) => readFile(join(home, "logs", name), "utf8")),
    )
  ).join("\n");
  expect(logs).toContain("real notification failure");
});

test(
  "notification close cancels offline push before waiting for replay and logs no failure",
  { timeout: 5000 },
  async ({ onTestFinished }) => {
    const { createDaemonNotifications } = await import("./notifications.ts");
    const { Store, createDevThread } = await import("./index.ts");
    const { DeviceId } = await import("@ace/protocol");
    const home = await mkdtemp(join(tmpdir(), "ace-smoke-push-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const store = new Store(join(home, "events.sqlite"));
    onTestFinished(() => store.close());
    const errors: unknown[] = [];
    const delivering = Promise.withResolvers<void>();
    let aborted = false;
    const notifications = createDaemonNotifications(
      home,
      store,
      (error) => errors.push(error),
      {
        apns: {
          send(_device, _notification, signal) {
            delivering.resolve();
            return new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve("retry");
                },
                { once: true },
              );
            });
          },
        },
      },
      0,
    );
    onTestFinished(() => notifications.close());
    await notifications.service.register(DeviceId.parse("offline-phone"), {
      channel: "apns",
      platform: "phone",
      token: "ab".repeat(32),
    });
    const thread = createDevThread(store, store.createWorkspace(home, "Push"));
    store.appendEvents(thread.id, [{ type: "thread.updated", status: { state: "done" } }]);
    await notifications.start();
    await delivering.promise;
    await notifications.close();
    expect(aborted).toBe(true);
    expect(errors).toEqual([]);
  },
);
