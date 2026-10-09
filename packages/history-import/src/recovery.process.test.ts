import { afterEach, expect, test } from "vitest";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { openHistory } from "./index.ts";
import { environment, jsonl, claudeRecords, cwd, memorySink, init, text } from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

test("a crashed scan restarts with backoff and cached sessions can still be listed and imported", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const home = join(env.root, "claude");
  for (let i = 0; i < 130; i++)
    await jsonl(
      join(home, "projects/p", i + ".jsonl"),
      claudeRecords("Recover conversation " + i, "session-" + i),
    );
  let isolate: Worker | undefined;
  const retry = Promise.withResolvers<() => void>();
  const delays: number[] = [];
  const service = await openHistory(
    {
      indexPath: join(env.root, "ace/index.sqlite"),
      instances: [{ id: "claude", provider: "claude", homeDir: home }],
    },
    (url, options) => {
      isolate = new Worker(url, options);
      return isolate;
    },
    {
      delay: (run, milliseconds) => {
        if (milliseconds !== 5000) {
          delays.push(milliseconds);
          retry.resolve(run);
        }
        return () => {};
      },
    },
  );
  cleanup.push(() => service.close());
  await service.scan();
  let killed = false;
  const scanning = service.scan(undefined, async () => {
    if (!killed) {
      killed = true;
      await isolate?.terminate();
    }
  });
  await expect(scanning).rejects.toThrow();
  const listing = service.list({ type: "history.list", cwd });
  (await retry.promise)();
  const page = await listing;
  expect(page.sessions.length).toBeGreaterThan(0);
  expect(delays[0]).toBe(1000);
  const scan = await service.scanChanges();
  expect(scan.skipped).toBe(130);
  const source = page.sessions[0];
  if (!source) throw new Error("Missing cached session");
  const sink = memorySink();
  await service.importSession(init(source.id), sink);
  expect(text(sink.items)).toContain(source.title);
});

test("startup failures back off repeatedly before the durable catalog becomes available", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const scheduled: { run: () => void; milliseconds: number }[] = [];
  let notify = Promise.withResolvers<void>();
  let launches = 0;
  const opening = openHistory(
    { indexPath: join(env.root, "ace/index.sqlite"), instances: [] },
    (url, options) => {
      launches++;
      return launches <= 2
        ? new Worker('throw new Error("Synthetic startup failure")', { eval: true })
        : new Worker(url, options);
    },
    {
      delay(run, milliseconds) {
        scheduled.push({ run, milliseconds });
        notify.resolve();
        return () => {};
      },
    },
  );
  for (const deadline of [1000, 2000]) {
    await notify.promise;
    const task = scheduled.shift();
    if (!task) throw new Error("Missing retry deadline");
    expect(task.milliseconds).toBe(deadline);
    notify = Promise.withResolvers<void>();
    task.run();
  }
  const service = await opening;
  cleanup.push(() => service.close());
  expect((await service.list({ type: "history.list", cwd })).sessions).toEqual([]);
});

test("closing during backoff rejects waiting reads and cancels recovery", async () => {
  const env = await environment();
  cleanup.push(env.close);
  let isolate: Worker | undefined;
  let retryCancelled = false;
  const failed = Promise.withResolvers<void>();
  const service = await openHistory(
    { indexPath: join(env.root, "ace/index.sqlite"), instances: [] },
    (url, options) => (isolate = new Worker(url, options)),
    {
      delay(_run, milliseconds) {
        if (milliseconds !== 5000) failed.resolve();
        return () => {
          if (milliseconds !== 5000) retryCancelled = true;
        };
      },
    },
  );
  cleanup.push(() => service.close());
  await isolate?.terminate();
  await failed.promise;
  const listing = service.list({ type: "history.list", cwd });
  const rejected = expect(listing).rejects.toThrow("closed");
  await service.close();
  await rejected;
  expect(retryCancelled).toBe(true);
});
