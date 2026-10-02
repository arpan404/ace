import { expect, it } from "vitest";
import { repository } from "./test-support.ts";
import { ReviewWorker } from "./index.ts";

it("the worker persists commands and returns the same receipt after restart", async () => {
  const repo = await repository();
  let worker = new ReviewWorker(repo.directory + "/worker.sqlite");
  try {
    const command = repo.command(
      { type: "review.open", source: repo.session.source },
      "worker-open",
    );
    const first = await worker.handle(command, repo.root);
    expect(first.ok).toBe(true);
    await worker.close();
    worker = new ReviewWorker(repo.directory + "/worker.sqlite");
    expect(await worker.handle(command, repo.root)).toEqual(first);
    const listed = await worker.handle(repo.command({ type: "review.list" }));
    expect(listed.review?.sessions?.[0]?.id).toBe(first.review?.session?.id);
  } finally {
    await worker.close();
    await repo.close();
  }
});
it("the worker imports reviewer findings and delivers selected structured fixes", async () => {
  const repo = await repository();
  const intents: unknown[] = [];
  const worker = new ReviewWorker(repo.directory + "/worker.sqlite", {
    async fix(intent) {
      intents.push(intent);
    },
    async review(intent) {
      intents.push(intent);
      return {
        comments: [
          { position: { file: "file.ts", side: "new", start: 3, end: 3 }, text: "Worker review" },
        ],
      };
    },
  });
  try {
    const opened = await worker.handle(
      repo.command({ type: "review.open", source: repo.session.source }),
      repo.root,
    );
    const sessionId = opened.review?.session?.id;
    expect(
      (
        await worker.handle(
          repo.command({ type: "review.askReviewer", sessionId, threadId: "thread" }),
          undefined,
          repo.target,
        )
      ).ok,
    ).toBe(true);
    const listed = await worker.handle(repo.command({ type: "review.list", sessionId }));
    expect(listed.review?.comments?.[0]?.text).toBe("Worker review");
    const fixed = await worker.handle(
      repo.command({
        type: "review.sendToAgent",
        sessionId,
        threadId: "thread",
        commentIds: listed.review?.comments?.map((c) => c.id),
      }),
      undefined,
      repo.target,
    );
    expect(fixed.review?.session?.status).toBe("changes-requested");
    expect(intents).toMatchObject([
      { kind: "review-run", diff: expect.stringContaining("wrong") },
      { kind: "review-fix", comments: [{ text: "Worker review" }] },
    ]);
  } finally {
    await worker.close();
    await repo.close();
  }
});
it("retries of interrupted execution require recovery instead of repeating the effect", async () => {
  const repo = await repository();
  let entered: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const worker = new ReviewWorker(repo.directory + "/worker.sqlite", {
    async fix(_intent, signal) {
      entered?.();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Canceled")), { once: true });
      });
    },
    async review() {
      return { comments: [] };
    },
  });
  let restarted: ReviewWorker | undefined;
  try {
    const opened = await worker.handle(
      repo.command({ type: "review.open", source: repo.session.source }),
      repo.root,
    );
    const sessionId = opened.review?.session?.id;
    const comment = await worker.handle(
      repo.command({
        type: "review.comment",
        sessionId,
        position: { file: "file.ts", side: "new", start: 3, end: 3 },
        text: "Fix",
      }),
    );
    const command = repo.command(
      {
        type: "review.sendToAgent",
        sessionId,
        threadId: "thread",
        commentIds: [comment.review?.comment?.id],
      },
      "interrupted-fix",
    );
    const pending = worker.handle(command, undefined, repo.target).catch(() => undefined);
    await barrier;
    await worker.close();
    await pending;
    restarted = new ReviewWorker(repo.directory + "/worker.sqlite");
    expect(await restarted.handle(command, undefined, repo.target)).toMatchObject({
      ok: false,
      error: "review_recovery_required",
    });
  } finally {
    await restarted?.close();
    await worker.close();
    await repo.close();
  }
});

it("the engine completion port marks touched findings pending review", async () => {
  const repo = await repository();
  const worker = new ReviewWorker(repo.directory + "/worker.sqlite");
  try {
    const opened = await worker.handle(
      repo.command({ type: "review.open", source: repo.session.source }),
      repo.root,
    );
    const sessionId = opened.review?.session?.id;
    if (!sessionId) throw new Error("Missing session");
    await worker.handle(
      repo.command({
        type: "review.comment",
        sessionId,
        position: { file: "file.ts", side: "new", start: 3, end: 3 },
        text: "Fix",
      }),
    );
    await repo.write("first\nbefore\nconst value = right;\nafter\nlast\n");
    expect((await worker.afterFix(sessionId, "fix-completed")).ok).toBe(true);
    const list = await worker.handle(repo.command({ type: "review.list", sessionId }));
    expect(list.review?.comments?.[0]?.anchor.state).toBe("addressed-pending-review");
    expect(list.review?.comments?.[0]?.resolved).toBe(false);
  } finally {
    await worker.close();
    await repo.close();
  }
});

it("reviews remain readable while a reviewer is waiting and excess work gets backpressure", async () => {
  const repo = await repository();
  let started: (() => void) | undefined;
  let finish: ((value: unknown) => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const output = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const worker = new ReviewWorker(repo.directory + "/worker.sqlite", {
    async fix() {},
    async review() {
      started?.();
      return output;
    },
  });
  try {
    const opened = await worker.handle(
      repo.command({ type: "review.open", source: repo.session.source }),
      repo.root,
    );
    const sessionId = opened.review?.session?.id;
    const reviewing = worker.handle(
      repo.command({ type: "review.askReviewer", sessionId, threadId: "thread" }),
      undefined,
      repo.target,
    );
    await entered;
    expect(
      (await worker.handle(repo.command({ type: "review.list", sessionId }))).review?.comments,
    ).toEqual([]);
    const queued = Array.from({ length: 15 }, () =>
      worker.handle(repo.command({ type: "review.status", sessionId, status: "open" })),
    );
    expect(await worker.handle(repo.command({ type: "review.list", sessionId }))).toMatchObject({
      ok: false,
      error: "review_busy",
    });
    finish?.({ comments: [] });
    expect((await reviewing).ok).toBe(true);
    expect((await Promise.all(queued)).every((result) => result.ok)).toBe(true);
  } finally {
    finish?.({ comments: [] });
    await worker.close();
    await repo.close();
  }
});
it("receipt recovery never starts an unknown effect and returns completed work", async () => {
  const repo = await repository();
  const worker = new ReviewWorker(repo.directory + "/worker.sqlite");
  try {
    const command = repo.command(
      { type: "review.open", source: repo.session.source },
      "recover-open",
    );
    expect(await worker.recover(command)).toMatchObject({
      ok: false,
      error: "review_recovery_required",
    });
    expect((await worker.handle(repo.command({ type: "review.list" }))).review?.sessions).toEqual(
      [],
    );
    const completed = await worker.handle(command, repo.root);
    expect(await worker.recover(command)).toEqual(completed);
    expect(
      (await worker.handle(repo.command({ type: "review.list" }))).review?.sessions,
    ).toHaveLength(1);
  } finally {
    await worker.close();
    await repo.close();
  }
});
