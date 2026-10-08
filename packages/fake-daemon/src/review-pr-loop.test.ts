import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { Command, DeviceId, ThreadId, WorkspaceId } from "@ace/protocol";
import { FakeDaemon, fakeTransport, coldStartReplay, ScenarioPlayer } from "./index.ts";

async function fixture() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  new ScenarioPlayer(daemon, coldStartReplay()).runUntilBlocked();
  const threadId = ThreadId.parse("thread-cold-start");
  daemon.apply(threadId, [
    { type: "turn.started", agent: "root", nativeTurnId: "busy", trigger: "user" },
  ]);
  let serial = 0;
  const client = new Client({
    deviceId: DeviceId.parse("device"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `request-${++serial}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  const send = (payload: unknown, id = `loop-${++serial}`) =>
    client.command(Command.parse({ id, deviceId: "device", payload }).payload, {}, id);
  return { daemon, client, send, threadId };
}

test("fake review sends queue once, sessions sync, replies persist and suggestions patch checkout files", async () => {
  const f = await fixture();
  try {
    const opened = await f.send({
      type: "review.open",
      source: {
        workspaceId: WorkspaceId.parse("ace"),
        threadId: f.threadId,
        from: { kind: "commit", ref: "HEAD" },
        to: { kind: "working-tree" },
      },
    });
    const sessionId = opened.review?.session?.id;
    const added = await f.send({
      type: "review.comment",
      sessionId,
      position: { file: "apps/server/src/replay.ts", side: "new", start: 2, end: 3 },
      text: "Review the range",
      suggestion: "fixed",
    });
    const commentId = added.review?.comment?.id;
    const sent = {
      type: "review.sendToAgent",
      sessionId,
      threadId: f.threadId,
      commentIds: [commentId],
    };
    expect(await f.send(sent, "send-review")).toMatchObject({ ok: true });
    expect(await f.send(sent, "send-review")).toMatchObject({ ok: true });
    const queued = (await f.client.request({ type: "queue.get", threadId: f.threadId })).queue;
    expect(queued.total).toBe(1);
    expect(queued.messages[0]?.input).toEqual([
      { type: "text", text: expect.stringContaining("apps/server/src/replay.ts:2-3") },
    ]);
    expect(await f.send({ type: "review.list", threadId: f.threadId })).toMatchObject({
      ok: true,
      review: { sessions: [{ id: sessionId }] },
    });
    expect(await f.send({ type: "review.list", threadId: "other" })).toMatchObject({
      ok: true,
      review: { sessions: [] },
    });
    expect(
      await f.send({ type: "review.reply", sessionId, commentId, text: "Agreed" }),
    ).toMatchObject({ ok: true });
    expect(await f.send({ type: "review.list", sessionId, commentId })).toMatchObject({
      ok: true,
      review: { replies: [{ text: "Agreed" }] },
    });
    expect(await f.send({ type: "review.applySuggestion", sessionId, commentId })).toMatchObject({
      ok: true,
      review: { comment: { anchor: { state: "addressed-pending-review" } } },
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of f.client.downloadFile({
      threadId: f.threadId,
      op: "download",
      path: "apps/server/src/replay.ts",
      offset: 0,
    }))
      chunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(chunks)).split("\n")[1]).toBe("fixed");
    expect(await f.send({ type: "review.applySuggestion", sessionId, commentId })).toMatchObject({
      ok: false,
      error: "review_suggestion_conflict",
    });
    expect(
      await f.send({ type: "review.askReviewer", sessionId, threadId: f.threadId }),
    ).toMatchObject({ ok: false, error: "review_reviewer_unavailable" });
  } finally {
    await f.client.close();
  }
});

test("fake PR creation reuses the same branch PR and merge errors match production", async () => {
  const f = await fixture();
  try {
    const repository = { forge: "github", host: "github.com", owner: "octo", name: "ace" };
    const create = {
      type: "forge.pr.create",
      threadId: f.threadId,
      repository,
      input: {
        branch: "topic",
        base: "main",
        title: "Review",
        summary: "Review",
        template: { title: "{{title}}", body: "{{summary}}" },
        draft: false,
      },
    };
    const first = await f.send(create);
    expect(first).toMatchObject({ ok: true, pr: { number: 1 } });
    expect(await f.send(create)).toMatchObject({
      ok: true,
      pr: first.pr,
      prStatus: { state: "open" },
    });
    const link = { threadId: f.threadId, pr: first.pr };
    expect(
      await f.send({ type: "forge.pr.merge", link, headSha: "0".repeat(40), method: "squash" }),
    ).toMatchObject({ ok: false, error: "forge_conflict" });
    expect(
      await f.send({
        type: "forge.pr.merge",
        link,
        headSha: first.prStatus?.headSha,
        method: "squash",
      }),
    ).toMatchObject({ ok: true, prStatus: { state: "merged" } });
    expect(
      await f.send({
        ...create,
        repository: { ...repository, forge: "gitlab", host: "gitlab.com" },
      }),
    ).toMatchObject({ ok: false, error: "forge_unsupported" });
  } finally {
    await f.client.close();
  }
});
