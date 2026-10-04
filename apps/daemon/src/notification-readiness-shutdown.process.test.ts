/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker_threads boundary. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { expect, test } from "vitest";
import { Store } from "./index.ts";
import { createDaemonNotifications } from "./notifications.ts";
import { NotificationWorker, attachNotifications } from "@ace/notify";
import { createDevThread } from "./index.ts";

function gate(method: string) {
  const held = Promise.withResolvers<void>();
  let release: (() => void) | undefined;
  let armed = false;
  let released = false;
  return {
    held: held.promise,
    arm() {
      armed = true;
    },
    release() {
      if (released) return;
      released = true;
      release?.();
    },
    spawn(entry: URL, options: ConstructorParameters<typeof Worker>[1]) {
      const worker = new Worker(entry, options);
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message: unknown) => {
        const parsed = z
          .object({ type: z.literal("call"), call: z.object({ method: z.string() }) })
          .safeParse(message);
        if (armed && !release && parsed.success && parsed.data.call.method === method) {
          release = () => post(message);
          held.resolve();
        } else post(message);
      };
      return worker;
    },
  };
}
for (const method of ["cursor", "revoke"])
  test(`shutdown during an outstanding readiness ${method} settles warmup as cancellation`, async ({
    onTestFinished,
  }) => {
    const home = await mkdtemp(join(tmpdir(), "ace-readiness-close-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const store = new Store(join(home, "events.sqlite"));
    onTestFinished(() => store.close());
    for (const name of ["Revoked phone", "Revoked tablet"]) {
      const paired = store.devices.create(name, ["read"], 1);
      store.devices.revoke(paired.device.id, 2);
    }
    const io = gate(method),
      errors: unknown[] = [];
    const notifications = createDaemonNotifications(
      home,
      store,
      (error) => errors.push(error),
      {},
      0,
      { spawn: io.spawn },
    );
    onTestFinished(() => {
      io.release();
      return notifications.close();
    });
    await notifications.open();
    io.arm();
    const readiness = notifications.ready().then(
      () => "ready",
      (error: unknown) => error,
    );
    await io.held;
    const closing = notifications.close();
    // The caller never releases the held RPC. Shutdown must cancel readiness
    // independently while preserving uncancelled ingestion and presence calls.
    const result = await readiness;
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({ name: "AbortError" });
    await closing;
    expect(errors).toEqual([]);
  });

test("subscriber shutdown waits for an outstanding ingest to persist its cursor before the worker closes", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-ingestion-close-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  onTestFinished(() => store.close());
  const io = gate("ingest"),
    errors: unknown[] = [];
  const path = join(home, "notifications.sqlite");
  const worker = new NotificationWorker({
    path,
    spawn: io.spawn,
    transport: {
      async send() {
        return "retry";
      },
    },
  });
  onTestFinished(() => {
    io.release();
    return worker.close();
  });
  const attached = attachNotifications(worker, store, (error) => errors.push(error));
  onTestFinished(() => {
    io.release();
    return attached.close();
  });
  await worker.cursor();
  io.arm();
  const thread = createDevThread(store, store.createWorkspace(home, "Ingest"));
  await io.held;
  const expected = store.readEvents({ afterSeq: 0, limit: 256 }).at(-1)?.seq;
  if (expected === undefined) throw new Error("Missing durable event sequence");
  const closing = attached.close().then(() => worker.close());
  // Allow shutdown continuations to reach the worker before releasing the ingest.
  // A missing ingestion barrier posts close first and loses this durable event.
  await setImmediate();
  io.release();
  await closing;
  const reopened = new NotificationWorker({
    path,
    transport: {
      async send() {
        return "retry";
      },
    },
  });
  onTestFinished(() => reopened.close());
  expect(await reopened.cursor()).toBe(expected);
  expect(store.getThread(thread.id)?.id).toBe(thread.id);
  expect(errors).toEqual([]);
});

test("aborting an opened worker preserves admitted database and presence RPCs until explicit close", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-open-worker-abort-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const io = gate("cursor"),
    lifetime = new AbortController();
  const worker = new NotificationWorker({
    path: join(home, "notifications.sqlite"),
    signal: lifetime.signal,
    spawn: io.spawn,
    transport: {
      async send() {
        return "retry";
      },
    },
  });
  onTestFinished(() => {
    io.release();
    return worker.close();
  });
  await worker.cursor();
  io.arm();
  const admitted = worker.cursor();
  // Observe rejection immediately so an incorrect abort cannot become an unhandled rejection.
  const settled = admitted.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await io.held;
  lifetime.abort();
  io.release();
  expect(await settled).toEqual({ value: 0 });
  await expect(worker.disconnect("closed-session")).resolves.toBeUndefined();
  await worker.close();
});
