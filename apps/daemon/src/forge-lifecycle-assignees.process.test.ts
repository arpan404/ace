import { expect, test } from "vitest";
import type { ForgeLifecycleAction } from "@ace/protocol";
import { lifecycleFixtures, lifecycleRecord, sha } from "@ace/forge/testing";
import { setupLifecycle } from "./forge-lifecycle-test-support.ts";
const noopAsync = async () => {};

test("assignee casing aliases are accepted and leave later lifecycle writes available after restart", async () => {
  const assigned = lifecycleRecord({
    assignees: { nodes: [{ id: "U_2", login: "alice" }], pageInfo: { hasNextPage: false } },
  });
  const fixtures = lifecycleFixtures();
  fixtures["graphql:user(login:"] = [
    { body: { data: { repository: { id: "R_1" }, u0: { id: "U_2", login: "alice" } } } },
  ];
  fixtures["graphql:mutation($input:UpdatePullRequestInput!"] = [
    { body: { data: { updatePullRequest: { pullRequest: { headRefOid: sha } } } } },
  ];
  fixtures["graphql:mutation($input:ClosePullRequestInput!"] = [
    { body: { data: { closePullRequest: { pullRequest: { headRefOid: sha } } } } },
  ];
  let nextHost = assigned;
  let publish = noopAsync;
  const f = await setupLifecycle(fixtures, async (request, run) => {
    const response = await run(request);
    if (request.input?.includes("mutation($input:")) await publish();
    return response;
  });
  try {
    publish = () => f.gh.replace({ ...fixtures, ...lifecycleFixtures([nextHost]) });
    const before = await f.read();
    const action = {
      kind: "edit",
      changes: { assignees: ["ALICE"] },
    } satisfies ForgeLifecycleAction;
    expect(await f.send("assign", action, before.snapshot.version)).toMatchObject({
      ok: true,
      forgeLifecycle: { outcome: "accepted" },
    });
    expect((await f.read()).snapshot.metadata.assignees).toEqual(["alice"]);
    await f.restart();
    const restored = await f.read();
    expect(restored.operations).toContainEqual(
      expect.objectContaining({ id: "assign", state: "accepted" }),
    );
    // Reconciliation treats duplicates and casing aliases as the same identity set.
    expect(
      await f.gh.forge.lifecycle.observe(
        7,
        { kind: "edit", changes: { assignees: ["ALICE", "alice"] } },
        restored.snapshot,
        "observe",
        new AbortController().signal,
      ),
    ).toMatchObject({ outcome: "accepted" });
    nextHost = lifecycleRecord({ ...assigned, state: "CLOSED" });
    expect(await f.send("close", { kind: "close" }, restored.snapshot.version)).toMatchObject({
      ok: true,
      forgeLifecycle: { outcome: "accepted" },
    });
  } finally {
    await f.cleanup();
  }
});
