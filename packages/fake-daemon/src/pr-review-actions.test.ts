import { expect, test } from "vitest";
import { Client } from "@ace/client";
import {
  DeviceId,
  WorkspaceId,
  type ForgeRepository,
  type ForgeReviewAction,
  type ForgeReviewState,
} from "@ace/protocol";
import { FakeDaemon, fakeTransport, pullRequestDetails } from "./index.ts";

const workspaceId = WorkspaceId.parse("workspace");
const docs: ForgeRepository = {
  forge: "github",
  host: "github.com",
  owner: "acme",
  name: "docs-site",
};
const headSha = "31".padEnd(40, "3");

async function connect() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.workspace.seedPullRequests(pullRequestDetails(1_000_000));
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("phone"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `id-${++sequence}`,
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
  const read = async (op: "forge.pr.review-state" | "forge.pr.detail", number = 31) => {
    const reply = await client.request({
      type: "workspace.request",
      operation: { op, workspaceId, repository: docs, number },
    });
    if (reply.result.kind !== "forge") throw new Error("No forge read");
    return reply.result.data;
  };
  return {
    daemon,
    client,
    send: (action: ForgeReviewAction, number = 31) =>
      client.command({
        type: "forge.hosted.review",
        workspaceId,
        pr: { repository: docs, number },
        action,
      }),
    async review(): Promise<ForgeReviewState> {
      const data = await read("forge.pr.review-state");
      if (data.resource !== "prReviewState") throw new Error("No review state");
      return data.value;
    },
    async threads() {
      const data = await read("forge.pr.detail");
      if (data.resource !== "prDetail") throw new Error("No detail");
      return data.value.status.reviewThreads;
    },
  };
}

test("the sample PR's threads sit on lines its patch draws, with hidden comments and pending drafts", async () => {
  const f = await connect();
  try {
    const threads = await f.threads();
    expect(
      threads.map((t) => [t.file, t.side, t.startLine, t.line, t.resolved, t.outdated]),
    ).toEqual([
      ["docs/install.md", "RIGHT", null, 12, false, false],
      ["docs/service.md", "RIGHT", 3, 6, false, false],
      ["docs/install.md", "LEFT", null, 4, false, false],
      ["docs/troubleshooting.md", "RIGHT", null, 5, true, false],
      ["docs/docker.md", "RIGHT", null, null, false, true],
    ]);
    const review = await f.review();
    expect(review.hidden).toEqual([{ source: "issue", commentId: 320, reason: "outdated" }]);
    expect(review.hideable).toContainEqual({ source: "issue", commentId: 320 });
    expect(review.drafts.map((d) => d.id)).toEqual(["draft-stop", "draft-volume"]);
    // The viewer wrote this PR, so GitHub would refuse their approval.
    expect(review.canReview).toBe(false);
  } finally {
    await f.client.close();
  }
});

test("a line comment opens a thread at its anchor and leaves the drafts pending", async () => {
  const f = await connect();
  try {
    const anchor = { commit: headSha, path: "docs/service.md", line: 9, side: "RIGHT" as const };
    expect(await f.send({ kind: "line.comment", headSha, anchor, body: "Say why" })).toMatchObject({
      ok: true,
    });
    expect((await f.threads()).at(-1)).toMatchObject({
      file: "docs/service.md",
      line: 9,
      side: "RIGHT",
      comments: [{ body: "Say why", author: "you" }],
    });
    expect((await f.review()).drafts).toHaveLength(2);
    expect(
      await f.send({ kind: "line.comment", headSha, anchor: { ...anchor, line: 40 }, body: "x" }),
    ).toMatchObject({ ok: false, error: "forge_conflict" });
  } finally {
    await f.client.close();
  }
});

test("a line comment GitHub would refuse is refused here too, as the real backend does", async () => {
  const f = await connect();
  try {
    // Lines 2 and 9 are both in the sample patch, but on different sides.
    const across = {
      commit: headSha,
      path: "docs/service.md",
      line: 9,
      side: "RIGHT" as const,
      startLine: 2,
      startSide: "LEFT" as const,
    };
    expect(
      await f.send({ kind: "line.comment", headSha, anchor: across, body: "Across" }),
    ).toMatchObject({ ok: false, error: "forge_conflict" });
    const threads = (await f.threads()).length;
    expect(
      await f.send({
        kind: "line.comment",
        headSha,
        anchor: { ...across, startSide: "RIGHT" },
        body: "Same side",
      }),
    ).toMatchObject({ ok: true });
    expect(await f.threads()).toHaveLength(threads + 1);
  } finally {
    await f.client.close();
  }
});

test("hiding and unhiding a comment shows in the next review state", async () => {
  const f = await connect();
  try {
    await f.send({ kind: "comment.unhide", commentId: 320, source: "issue" });
    expect((await f.review()).hidden).toEqual([]);
    await f.send({ kind: "comment.hide", commentId: 320, source: "issue", reason: "resolved" });
    expect((await f.review()).hidden).toEqual([
      { source: "issue", commentId: 320, reason: "resolved" },
    ]);
    // Someone else's comment isn't the viewer's to hide.
    expect(
      await f.send({ kind: "comment.hide", commentId: 321, source: "issue", reason: "spam" }),
    ).toMatchObject({ ok: false, error: "forge_forbidden" });
  } finally {
    await f.client.close();
  }
});

test("submitting selected drafts turns them into threads and keeps the rest", async () => {
  const f = await connect();
  try {
    expect(
      await f.send({
        kind: "submit",
        event: "COMMENT",
        headSha,
        body: "",
        draftIds: ["draft-volume"],
      }),
    ).toMatchObject({ ok: true });
    expect((await f.review()).drafts.map((d) => d.id)).toEqual(["draft-stop"]);
    expect((await f.threads()).at(-1)).toMatchObject({
      file: "docs/docker.md",
      startLine: 3,
      line: 5,
    });
  } finally {
    await f.client.close();
  }
});

test("a PR whose review state a test scripted still leaves its review commands to the test", async () => {
  const f = await connect();
  try {
    const state = await f.review();
    f.daemon.workspace.setForgeRead(
      { op: "forge.pr.review-state", workspaceId, repository: docs, number: 31 },
      { resource: "prReviewState", value: state },
    );
    expect(await f.send({ kind: "comment.unhide", commentId: 320, source: "issue" })).toMatchObject(
      {
        ok: false,
        error: "unsupported_by_fake_daemon",
      },
    );
  } finally {
    await f.client.close();
  }
});
