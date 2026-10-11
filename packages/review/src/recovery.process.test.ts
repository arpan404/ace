import { Worker } from "node:worker_threads";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { ReviewWorker } from "./index.ts";
import { repository } from "./test-support.ts";

const list = (id: string) =>
  Command.parse({ id, deviceId: "device", payload: { type: "review.list" } });

test("the same review owner reopens its database after a physical exit and recovers completed receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-review-recovery-"));
  let isolate: Worker | undefined;
  const owner = new ReviewWorker(join(root, "reviews.sqlite"), undefined, {
    createWorker(url, options) {
      isolate = new Worker(url, options);
      return isolate;
    },
  });
  try {
    const command = list("completed");
    const before = await owner.handle(command);
    expect(before.ok).toBe(true);
    if (!isolate) throw new Error("Missing isolate");
    await isolate.terminate();
    expect(await owner.recover(command)).toEqual(before);
    expect(await owner.handle(list("later"))).toMatchObject({ ok: true, review: { sessions: [] } });
    await owner.close();
    await expect(owner.handle(list("disposed"))).rejects.toThrow("closed");
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh comments after worker replacement persist and their receipts survive another exit", async () => {
  const repo = await repository();
  let isolate: Worker | undefined;
  const owner = new ReviewWorker(join(repo.directory, "fresh-mutation.sqlite"), undefined, {
    createWorker(url, options) {
      isolate = new Worker(url, options);
      return isolate;
    },
  });
  try {
    const opened = await owner.handle(
      repo.command({ type: "review.open", source: repo.session.source }),
      repo.root,
    );
    expect(opened.ok).toBe(true);
    const sessionId = opened.review?.session?.id;
    if (!sessionId || !isolate) throw new Error("Missing review session or isolate");
    await isolate.terminate();
    const command = repo.command(
      {
        type: "review.comment",
        sessionId,
        position: { file: "file.ts", side: "new", start: 3, end: 3 },
        text: "Created after replacement",
      },
      "fresh-comment",
    );
    const created = await owner.handle(command);
    expect(created).toMatchObject({
      ok: true,
      review: { comment: { sessionId, text: "Created after replacement" } },
    });
    expect(
      (await owner.handle(repo.command({ type: "review.list", sessionId }))).review?.comments,
    ).toEqual([created.review?.comment]);
    await isolate.terminate();
    expect(await owner.recover(command)).toEqual(created);
    expect(
      (await owner.handle(repo.command({ type: "review.list", sessionId }))).review?.comments,
    ).toEqual([created.review?.comment]);
  } finally {
    await owner.close();
    await repo.close();
  }
});

test("replacement waits for old executor cleanup and never repeats or imports an interrupted review", async () => {
  const repo = await repository();
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let isolate: Worker | undefined;
  let executions = 0;
  const owner = new ReviewWorker(
    join(repo.directory, "isolated.sqlite"),
    {
      async fix() {},
      async review(_intent, signal) {
        executions++;
        entered.resolve();
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        await release.promise;
        return {
          comments: [
            { position: { file: "file.ts", side: "new", start: 3, end: 3 }, text: "Late finding" },
          ],
        };
      },
    },
    {
      createWorker(url, options) {
        isolate = new Worker(url, options);
        return isolate;
      },
    },
  );
  try {
    const opened = await owner.handle(
      repo.command({ type: "review.open", source: repo.session.source }),
      repo.root,
    );
    const sessionId = opened.review?.session?.id;
    const command = repo.command(
      { type: "review.askReviewer", sessionId, threadId: "thread" },
      "interrupted",
    );
    const pending = owner.handle(command, undefined, repo.target).catch(() => undefined);
    await entered.promise;
    if (!isolate) throw new Error("Missing isolate");
    await isolate.terminate();
    await aborted.promise;
    let readSettled = false;
    const reading = owner.handle(repo.command({ type: "review.list", sessionId })).finally(() => {
      readSettled = true;
    });
    void reading.catch(() => {});
    await writeFile(join(repo.directory, "cleanup-pending"), "checkpoint");
    expect(readSettled).toBe(false);
    release.resolve();
    expect((await reading).review?.comments).toEqual([]);
    expect(await owner.recover(command)).toMatchObject({
      ok: false,
      error: "review_recovery_required",
    });
    expect(await owner.handle(command, undefined, repo.target)).toMatchObject({
      ok: false,
      error: "review_recovery_required",
    });
    expect(executions).toBe(1);
    await pending;
  } finally {
    release.resolve();
    await owner.close();
    await repo.close();
  }
});

test("repeated startup faults exhaust a bounded recovery budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-review-faults-"));
  const owner = new ReviewWorker(join(root, "review.sqlite"), undefined, {
    createWorker() {
      return new Worker("process.exit(1)", { eval: true });
    },
  });
  try {
    for (let i = 0; i < 3; i++) await expect(owner.handle(list(`fault-${i}`))).rejects.toThrow();
    await expect(owner.handle(list("exhausted"))).rejects.toThrow("recovery exhausted");
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closing during recovery cancels the wait and rejects admitted calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-review-cancel-recovery-"));
  const waiting = Promise.withResolvers<void>();
  let isolate: Worker | undefined;
  const owner = new ReviewWorker(join(root, "review.sqlite"), undefined, {
    createWorker(url, options) {
      isolate = new Worker(url, options);
      return isolate;
    },
    scheduleRecovery() {
      waiting.resolve();
      return () => {};
    },
  });
  try {
    expect((await owner.handle(list("before-close"))).ok).toBe(true);
    if (!isolate) throw new Error("Missing isolate");
    await isolate.terminate();
    const pending = owner.handle(list("waiting"));
    const rejected = expect(pending).rejects.toThrow("Review worker closed");
    await waiting.promise;
    await owner.close();
    await rejected;
    await expect(owner.recover(list("before-close"))).rejects.toThrow("Review worker closed");
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("normal idle retirement reopens the same owner without exhausting recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-review-idle-recovery-"));
  let retired = Promise.withResolvers<void>();
  const owner = new ReviewWorker(join(root, "review.sqlite"), undefined, {
    createWorker(url, options) {
      const isolate = new Worker(url, options);
      isolate.once("exit", () => retired.resolve());
      return isolate;
    },
  });
  try {
    const command = list("idle-receipt");
    const before = await owner.handle(command);
    expect(before.ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      await retired.promise;
      retired = Promise.withResolvers<void>();
      expect(await owner.handle(list(`idle-${i}`))).toMatchObject({ ok: true });
    }
    expect(await owner.recover(command)).toEqual(before);
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
