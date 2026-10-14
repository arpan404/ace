import { join } from "node:path";
import { expect, test } from "vitest";
import { git, host, run, stackFixture as fixture } from "./testing/stack-publish-fixture.ts";

test("a rebased stack publishes every moved layer in one leased push and settles as rebased", async () => {
  const f = await fixture();
  try {
    expect(await f.command("rebase", "rebase", f.expected(f.reviewed, f.before))).toMatchObject({
      ok: true,
      stackOperation: { state: "push_partial" },
    });
    const { rebased, after } = await f.rebaseLocally();
    expect(await f.command("publish", "push", f.expected(f.reviewed, after))).toMatchObject({
      ok: true,
      stackOperation: { action: "push", state: "rebased" },
    });
    expect(await f.published()).toEqual([rebased.model, rebased.api, rebased.ui]);
    expect((await f.gh.requests()).some((request) => request.path === "stack-push")).toBe(false);
  } finally {
    await f.close();
  }
});

test("a collaborator commit pushed after review rejects the whole publication and moves no layer", async () => {
  const f = await fixture();
  try {
    await f.command("rebase", "rebase", f.expected(f.reviewed, f.before));
    const { after } = await f.rebaseLocally();
    const collaborator = join(f.remote, "..", "collaborator");
    await run("git", ["clone", "-q", "--branch", "api", f.remote, collaborator]);
    await git(collaborator, "config", "user.name", "Collaborator");
    await git(collaborator, "config", "user.email", "collaborator@example.invalid");
    await git(collaborator, "commit", "-q", "--allow-empty", "-m", "Collaborator fix");
    await git(collaborator, "push", "-q", "origin", "api");
    const theirs = await git(collaborator, "rev-parse", "HEAD");
    expect(await f.command("publish", "push", f.expected(f.reviewed, after))).toMatchObject({
      ok: false,
      stackOperation: { action: "push", state: "failed" },
    });
    expect(await f.published()).toEqual([f.reviewed.model, theirs, f.reviewed.ui]);
    // GitHub now reports the collaborator's head: the refusal names that layer and both heads.
    await f.gh.replace({
      ...host({ ...f.reviewed, api: theirs }),
      "stack-view": [{ body: after }],
    });
    expect(await f.read()).toMatchObject({
      result: {
        kind: "forge",
        data: {
          value: {
            operation: { action: "push", state: "failed" },
            movedLayers: [{ number: 8, branch: "api", reviewed: f.reviewed.api, current: theirs }],
          },
        },
      },
    });
  } finally {
    await f.close();
  }
});

test("a refreshed request carrying a newer GitHub revision cannot replace the reviewed leases", async () => {
  const f = await fixture();
  try {
    await f.command("rebase", "rebase", f.expected(f.reviewed, f.before));
    const { after } = await f.rebaseLocally();
    const moved = { ...f.reviewed, api: "f".repeat(40) };
    await f.gh.replace({ ...host(moved), "stack-view": [{ body: after }] });
    expect(await f.command("publish", "push", f.expected(moved, after))).toMatchObject({
      ok: false,
      error: "forge_conflict",
    });
    expect(await f.published()).toEqual([f.reviewed.model, f.reviewed.api, f.reviewed.ui]);
    expect(await f.read()).toMatchObject({
      result: {
        kind: "forge",
        data: {
          value: {
            operation: { action: "rebase", state: "push_partial" },
            movedLayers: [
              { number: 8, branch: "api", reviewed: f.reviewed.api, current: "f".repeat(40) },
            ],
          },
        },
      },
    });
  } finally {
    await f.close();
  }
});

test("a push whose result Git never reported settles from GitHub's heads instead of being repeated", async () => {
  const f = await fixture(true);
  try {
    await f.command("rebase", "rebase", f.expected(f.reviewed, f.before));
    const { rebased, after } = await f.rebaseLocally();
    expect(await f.command("publish", "push", f.expected(f.reviewed, after))).toMatchObject({
      stackOperation: { action: "push", state: "uncertain" },
    });
    expect(await f.published()).toEqual([rebased.model, rebased.api, rebased.ui]);
    await f.gh.replace({ ...host(rebased), "stack-view": [{ body: after }] });
    expect(await f.read()).toMatchObject({
      result: {
        kind: "forge",
        data: { value: { operation: { action: "push", state: "rebased" } } },
      },
    });
  } finally {
    await f.close();
  }
});
