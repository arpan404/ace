import { afterEach, describe, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import type { CommandPayload } from "@ace/protocol";
import type { ChangesStep } from "@ace/ui-core/mobile";
import { ChangesSession, type ChangesOwner } from "./changes.ts";
import { gitAction } from "./git-actions.ts";
import { cancelDraft, writeDraft } from "./git-drafts.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const patch = [
  "diff --git a/src/queue.ts b/src/queue.ts",
  "--- a/src/queue.ts",
  "+++ b/src/queue.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

/** A thread with one changed file on a branch off main, read by an open Changes sheet. */
async function opened() {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({
    id: "git",
    workspaceId: "ace",
    title: "Fix the flaky queue test",
    provider: "codex",
    details: {
      branch: "fix/queue",
      baseBranch: "main",
      worktree: "/fake/worktrees/git",
      head: "b".repeat(40),
      ahead: 0,
      diff: { files: 1, additions: 1, deletions: 1 },
      repository: { forge: "github", host: "github.com", owner: "arpan404", name: "ace" },
    },
  });
  daemon.apply("git", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  daemon.workspace.setGitStatus("git", [
    { path: "src/queue.ts", status: "modified", additions: 1, deletions: 1, binary: false },
  ]);
  daemon.workspace.setGitDiff("git", patch);
  await client.start();
  const lease = client.thread("git");
  await until(() => lease.store.thread !== undefined, "thread snapshot");
  // What reaches the daemon, as the socket carries it.
  const sent: CommandPayload[] = [];
  const operations: string[] = [];
  const owner: ChangesOwner = {
    command: (payload) => {
      sent.push(payload);
      return client.command(payload);
    },
    request: ((input: Parameters<ChangesOwner["request"]>[0], options) => {
      if (input.type === "workspace.request") operations.push(input.operation.op);
      return client.request(input, options);
    }) as ChangesOwner["request"],
  };
  const sink = new RecordingSink();
  const session = new ChangesSession(owner, lease.store, "git", 1, sink, plainPreview);
  await until(() => sink.read("changes:summary")?.state === "ready", "first read");
  const act = async (action: Record<string, unknown>, id: string) => {
    await gitAction(owner, session, action, id, sink, plainPreview);
    return sink.read(`git:${id}`);
  };
  const draft = async (kind: "commit" | "create-pr", id: string) => {
    await writeDraft(owner, session, kind, id, sink, plainPreview);
    return sink.read("git:draft");
  };
  return { daemon, owner, session, sink, sent, operations, act, draft };
}
const step = (sink: RecordingSink) => sink.read("changes:summary")?.step as ChangesStep;

/** Commit, push and open a PR, so the sheet's next step is the PR's merge. */
async function withOpenPr() {
  const fixture = await opened();
  await fixture.act({ kind: "commit", message: "Fix the queue", push: true }, "c");
  await until(() => step(fixture.sink)?.kind === "create-pr", "create-pr step");
  await fixture.act({ kind: "create-pr", title: "Fix the queue" }, "p");
  await until(() => step(fixture.sink)?.kind === "merge", "merge step");
  return fixture;
}

describe("AI drafts in the Changes sheet", () => {
  test("a commit draft fills the message and the commit names the drafted files and fingerprint", async () => {
    const { daemon, draft, act, sent } = await opened();
    daemon.workspace.setDraftGenerator(async (_input, context) => ({
      subject: "Fix the flaky queue test",
      body: `Touches ${context.paths.join(", ")}`,
    }));
    expect(await draft("commit", "d1")).toMatchObject({
      type: "git.draft",
      id: "d1",
      for: "commit",
      state: "ready",
      subject: "Fix the flaky queue test",
      body: "Touches src/queue.ts",
    });
    const result = await act(
      { kind: "commit", message: "Fix the flaky queue test", push: false, drafted: true },
      "c1",
    );
    expect(result).toMatchObject({ ok: true, message: "Committed" });
    const commit = sent.find((payload) => payload.type === "git.commit");
    expect(commit).toMatchObject({ paths: ["src/queue.ts"] });
    expect(commit && "draftFingerprint" in commit && commit.draftFingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  test("cancelling a draft stops the daemon's writer and leaves the text alone", async () => {
    const { daemon, owner, session, sink, operations } = await opened();
    let started = false;
    daemon.workspace.setDraftGenerator(
      (_input, _context, signal) =>
        new Promise((_resolve, reject) => {
          started = true;
          signal.addEventListener("abort", () => reject(new Error("draft_cancelled")));
        }),
    );
    const writing = writeDraft(owner, session, "commit", "d2", sink, plainPreview);
    await until(() => started, "writer started");
    expect(sink.read("git:draft")).toMatchObject({ state: "drafting" });
    cancelDraft(session, "d2");
    await writing;
    expect(sink.read("git:draft")).toMatchObject({ id: "d2", state: "cancelled" });
    expect(sink.read("git:draft")).not.toHaveProperty("subject");
    await until(() => operations.includes("git.draft.cancel"), "cancel sent");
  });

  test("a draft the writer can't produce reads in the shared words", async () => {
    const { daemon, draft } = await opened();
    daemon.workspace.setDraftGenerator(async () => {
      throw new Error("draft_provider_unavailable");
    });
    expect(await draft("commit", "d3")).toMatchObject({
      state: "failed",
      message:
        "The selected CLI is unavailable or signed out. Install it and sign in, then generate again.",
    });
  });

  test("a drafted message with no draft behind it is refused before anything commits", async () => {
    const { act, sent } = await opened();
    const result = await act({ kind: "commit", message: "x", push: false, drafted: true }, "c2");
    expect(result).toMatchObject({ ok: false });
    expect(String(result?.message)).toContain("The selected changes moved");
    expect(sent.some((payload) => payload.type === "git.commit")).toBe(false);
  });

  test("a drafted PR names its base and fingerprint, and its summary becomes the body", async () => {
    const { daemon, act, draft, sent, sink } = await opened();
    await act({ kind: "commit", message: "Fix the queue", push: true }, "c3");
    await until(() => step(sink)?.kind === "create-pr", "create-pr step");
    daemon.workspace.setDraftGenerator(async () => ({
      subject: "Fix the flaky queue test",
      body: "Uses the injected clock.",
    }));
    expect(await draft("create-pr", "d4")).toMatchObject({ state: "ready", for: "create-pr" });
    const result = await act(
      {
        kind: "create-pr",
        title: "Fix the flaky queue test",
        summary: "Uses the injected clock.",
        drafted: true,
      },
      "p1",
    );
    expect(result).toMatchObject({ ok: true, message: "Pull request opened" });
    const create = sent.find((payload) => payload.type === "forge.pr.create");
    expect(create).toMatchObject({
      input: {
        base: "main",
        title: "Fix the flaky queue test",
        summary: "Uses the injected clock.",
      },
    });
    expect(create && "draftFingerprint" in create && create.draftFingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});

describe("Merging and reviews from the Changes sheet", () => {
  test("the sheet offers every forge merge method", async () => {
    const { sink } = await opened();
    expect(sink.read("changes:summary")?.methods).toEqual([
      { method: "squash", label: "Squash and merge" },
      { method: "merge", label: "Create a merge commit" },
      { method: "rebase", label: "Rebase and merge" },
    ]);
  });

  test("merge uses the method the person picked", async () => {
    const { act, sent, sink } = await withOpenPr();
    expect(await act({ kind: "merge", method: "rebase" }, "m1")).toMatchObject({
      ok: true,
      message: "Merged",
    });
    expect(sent.find((payload) => payload.type === "forge.pr.merge")).toMatchObject({
      method: "rebase",
    });
    await until(() => step(sink)?.kind !== "merge", "merged");
  });

  test("a method the forge list doesn't offer is refused before the forge sees it", async () => {
    const { act, sent } = await withOpenPr();
    for (const action of [{ kind: "merge", method: "octopus" }, { kind: "merge" }])
      expect(await act(action, "m2")).toMatchObject({
        ok: false,
        message: "Could not read that git action.",
      });
    expect(sent.some((payload) => payload.type === "forge.pr.merge")).toBe(false);
  });

  test("reviewers named when opening a PR are asked for review on it", async () => {
    const { act, sent, sink } = await opened();
    await act({ kind: "commit", message: "Fix the queue", push: true }, "c4");
    await until(() => step(sink)?.kind === "create-pr", "create-pr step");
    const result = await act(
      { kind: "create-pr", title: "Fix the queue", reviewers: "@ana, bo-2 ana" },
      "p2",
    );
    expect(result).toMatchObject({ ok: true, message: "Pull request opened and review requested" });
    // The request names the PR just opened, after it opened.
    const kinds = sent.map((payload) => payload.type);
    expect(kinds.indexOf("forge.review.request")).toBeGreaterThan(kinds.indexOf("forge.pr.create"));
    expect(sent.find((payload) => payload.type === "forge.review.request")).toMatchObject({
      link: { threadId: "git", pr: { number: 1 } },
      reviewers: ["ana", "bo-2"],
    });
  });

  test("an invalid reviewer name opens nothing", async () => {
    const { act, sent, sink } = await opened();
    await act({ kind: "commit", message: "Fix the queue", push: true }, "c5");
    await until(() => step(sink)?.kind === "create-pr", "create-pr step");
    const result = await act({ kind: "create-pr", title: "Fix", reviewers: "not/a/user" }, "p3");
    expect(result).toMatchObject({ ok: false, message: "“not/a/user” isn't a GitHub username" });
    expect(sent.some((payload) => payload.type === "forge.pr.create")).toBe(false);
  });

  test("an open PR can ask for review", async () => {
    const { act, sent } = await withOpenPr();
    expect(await act({ kind: "request-review", reviewers: "ana" }, "r1")).toMatchObject({
      ok: true,
      message: "Review requested",
    });
    expect(sent.find((payload) => payload.type === "forge.review.request")).toMatchObject({
      reviewers: ["ana"],
    });
  });
});
