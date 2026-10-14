import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  git,
  host,
  local,
  run,
  stackFixture,
  type Heads,
} from "./testing/stack-publish-fixture.ts";

type Fixture = Awaited<ReturnType<typeof stackFixture>>;

/** A collaborator pushes one commit to `branch` on GitHub, optionally writing files. */
async function collaborate(f: Fixture, branch: string, files: Record<string, string> = {}) {
  const clone = join(f.remote, "..", `collaborator-${branch}`);
  await run("git", ["clone", "-q", "--branch", branch, f.remote, clone]);
  await git(clone, "config", "user.name", "Collaborator");
  await git(clone, "config", "user.email", "collaborator@example.invalid");
  for (const [path, text] of Object.entries(files)) {
    await writeFile(join(clone, path), text);
    await git(clone, "add", "--", path);
  }
  await git(clone, "commit", "-q", "--allow-empty", "-m", `Collaborator fix on ${branch}`);
  await git(clone, "push", "-q", "origin", branch);
  return git(clone, "rev-parse", "HEAD");
}

/** Rebase locally, then let a collaborator move `branch` on GitHub after that review. */
async function movedAfterReview(f: Fixture, branch: keyof Heads, conflicting = false) {
  await f.command("rebase", "rebase", f.expected(f.reviewed, f.before));
  const rebase = await f.rebaseLocally(conflicting ? { [branch]: { "notes.txt": "ours\n" } } : {});
  const theirs = await collaborate(f, branch, conflicting ? { "notes.txt": "theirs\n" } : {});
  const now = { ...f.reviewed, [branch]: theirs };
  await f.gh.replace({
    ...host(now),
    "stack-view": [{ body: rebase.after }],
    "stack-rebase": [{ code: 0 }],
  });
  return { ...rebase, theirs, now };
}

function stackValue(result: unknown) {
  return (result as { result: { data: { value: unknown } } }).result.data.value;
}

test("collaborator commits are brought into the rebased layer and the next publication leases to GitHub's new head", async () => {
  const f = await stackFixture();
  try {
    const { rebased, after, theirs, now, trunk } = await movedAfterReview(f, "ui");
    expect(stackValue(await f.read())).toMatchObject({
      movedLayers: [{ number: 9, branch: "ui", reviewed: f.reviewed.ui, current: theirs }],
    });
    expect(await f.command("sync", "sync", f.expected(now, after))).toMatchObject({
      ok: true,
      stackOperation: { action: "sync", state: "push_partial" },
    });
    // The collaborator's commit now sits on the rebased layer, which is checked out again.
    const synced = await git(f.checkout, "rev-parse", "ui");
    expect(await git(f.checkout, "rev-parse", "ui^")).toBe(rebased.ui);
    expect(await git(f.checkout, "log", "-1", "--format=%s", "ui")).toBe("Collaborator fix on ui");
    expect(await git(f.checkout, "branch", "--show-current")).toBe("ui");
    expect(await f.published()).toEqual([f.reviewed.model, f.reviewed.api, theirs]);

    const restacked = local({ ...rebased, ui: synced }, trunk);
    await f.gh.replace({ ...host(now), "stack-view": [{ body: restacked }] });
    expect(stackValue(await f.read())).toMatchObject({ movedLayers: [] });
    expect(await f.command("publish", "push", f.expected(now, restacked))).toMatchObject({
      ok: true,
      stackOperation: { action: "push", state: "rebased" },
    });
    expect(await f.published()).toEqual([rebased.model, rebased.api, synced]);
  } finally {
    await f.close();
  }
});

test("the layers above a synced layer are restacked through gh stack, which never pushes", async () => {
  const f = await stackFixture();
  try {
    const { after, now } = await movedAfterReview(f, "api");
    await f.command("sync", "sync", f.expected(now, after));
    const restacks = (await f.gh.requests()).filter((request) => request.path === "stack-rebase");
    expect(restacks.at(-1)?.args).toEqual(["stack", "rebase", "--upstack", "--remote", "origin"]);
    expect((await f.gh.requests()).some((request) => request.path === "stack-push")).toBe(false);
  } finally {
    await f.close();
  }
});

test("a replay conflict waits for resolution, then Continue finishes the sync", async () => {
  const f = await stackFixture();
  try {
    const { after, now, rebased } = await movedAfterReview(f, "ui", true);
    expect(await f.command("sync", "sync", f.expected(now, after))).toMatchObject({
      stackOperation: { action: "sync", state: "conflict" },
    });
    expect(stackValue(await f.read())).toMatchObject({
      operation: { action: "sync", state: "conflict" },
      movedLayers: [],
    });
    await writeFile(join(f.checkout, "notes.txt"), "ours and theirs\n");
    await git(f.checkout, "add", "notes.txt");
    expect(await f.command("continue", "continue", f.expected(now, after))).toMatchObject({
      ok: true,
      stackOperation: { action: "sync", state: "push_partial" },
    });
    expect(await git(f.checkout, "rev-parse", "ui^")).toBe(rebased.ui);
    expect(await git(f.checkout, "show", "ui:notes.txt")).toBe("ours and theirs");
  } finally {
    await f.close();
  }
});

test("Continue before the replay conflict is staged is refused and keeps the resolution continuable", async () => {
  const f = await stackFixture();
  try {
    const { after, now } = await movedAfterReview(f, "ui", true);
    await f.command("sync", "sync", f.expected(now, after));
    expect(await f.command("continue", "continue", f.expected(now, after))).toMatchObject({
      ok: false,
    });
    expect(stackValue(await f.read())).toMatchObject({
      operation: { action: "sync", state: "conflict" },
    });
    await writeFile(join(f.checkout, "notes.txt"), "ours and theirs\n");
    await git(f.checkout, "add", "notes.txt");
    expect(await f.command("continue-staged", "continue", f.expected(now, after))).toMatchObject({
      ok: true,
      stackOperation: { action: "sync", state: "push_partial" },
    });
    expect(await git(f.checkout, "show", "ui:notes.txt")).toBe("ours and theirs");
  } finally {
    await f.close();
  }
});

test("aborting a conflicted sync restores every rebased layer and keeps the moved layer listed", async () => {
  const f = await stackFixture();
  try {
    const { after, now, rebased, theirs } = await movedAfterReview(f, "ui", true);
    await f.command("sync", "sync", f.expected(now, after));
    expect(await f.command("abort", "abort", f.expected(now, after))).toMatchObject({
      ok: true,
      stackOperation: { action: "abort", state: "push_partial" },
    });
    expect(await git(f.checkout, "rev-parse", "model", "api", "ui")).toBe(
      [rebased.model, rebased.api, rebased.ui].join("\n"),
    );
    expect(await git(f.checkout, "status", "--porcelain")).toBe("");
    expect(await git(f.checkout, "branch", "--show-current")).toBe("ui");
    expect(await f.published()).toEqual([f.reviewed.model, f.reviewed.api, theirs]);
    expect(stackValue(await f.read())).toMatchObject({
      movedLayers: [{ number: 9, branch: "ui", reviewed: f.reviewed.ui, current: theirs }],
    });
  } finally {
    await f.close();
  }
});

test("a layer force-pushed on GitHub is refused and no branch moves", async () => {
  const f = await stackFixture();
  try {
    await f.command("rebase", "rebase", f.expected(f.reviewed, f.before));
    const { after, rebased } = await f.rebaseLocally();
    // The collaborator replaces ui with a commit that drops the reviewed revision.
    await git(f.remote, "update-ref", "refs/heads/ui", f.reviewed.api);
    const theirs = await collaborate(f, "ui");
    const now = { ...f.reviewed, ui: theirs };
    await f.gh.replace({ ...host(now), "stack-view": [{ body: after }] });
    expect(await f.command("sync", "sync", f.expected(now, after))).toMatchObject({
      ok: false,
      stackOperation: { action: "sync", state: "failed" },
    });
    expect(await git(f.checkout, "rev-parse", "ui")).toBe(rebased.ui);
    expect(stackValue(await f.read())).toMatchObject({
      operation: { action: "rebase", state: "push_partial" },
      movedLayers: [{ number: 9, current: theirs }],
    });
  } finally {
    await f.close();
  }
});

test("a restack gh stack could not finish can only be aborted, which restores the rebased layers", async () => {
  const f = await stackFixture();
  try {
    const { after, now, rebased } = await movedAfterReview(f, "api");
    await f.gh.replace({
      ...host(now),
      "stack-view": [{ body: after }],
      "stack-rebase": [{ code: 1 }],
      "stack-rebase-abort": [{ code: 0 }],
    });
    expect(await f.command("sync", "sync", f.expected(now, after))).toMatchObject({
      stackOperation: { action: "sync", state: "uncertain" },
    });
    expect(await f.command("continue", "continue", f.expected(now, after))).toMatchObject({
      ok: false,
    });
    expect(await f.command("abort", "abort", f.expected(now, after))).toMatchObject({
      stackOperation: { action: "abort", state: "push_partial" },
    });
    expect(await git(f.checkout, "rev-parse", "api")).toBe(rebased.api);
    expect((await f.gh.requests()).some((request) => request.path === "stack-rebase-abort")).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});
