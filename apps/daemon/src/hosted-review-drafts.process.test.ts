import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command, WorkspaceActionRequest } from "@ace/protocol";
import { fakeGh, repository, sha } from "@ace/forge/testing";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
const host = {
  data: {
    viewer: { login: "reviewer" },
    repository: {
      pullRequest: {
        id: "PR_7",
        headRefOid: sha,
        state: "OPEN",
        viewerDidAuthor: false,
        locked: false,
        viewerCanUpdate: false,
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  },
};
const viewed = {
  data: {
    repository: {
      pullRequest: {
        headRefOid: sha,
        files: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  },
};
test("unsent hosted drafts survive daemon restart and remain isolated from another repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-hosted-drafts-"));
  const gh = await fakeGh({
    graphql: [{ body: host }, { body: viewed }, { body: host }, { body: viewed }],
  });
  let store = new Store(join(root, "store.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const options = {
    forgeRunner: () => (request: import("@ace/forge").CommandRequest) =>
      gh.runner({ ...request, command: gh.executable }),
  };
  let runtime = new WorkspaceRuntime(store, root, () => 1, options);
  try {
    expect(
      await runtime.execute(
        Command.parse({
          id: "save",
          deviceId: "device",
          payload: {
            type: "forge.hosted.review",
            workspaceId,
            pr: { repository, number: 7 },
            action: {
              kind: "draft.save",
              draft: {
                id: "draft",
                body: "Unsent",
                anchor: { commit: sha, path: "src/main.ts", line: 1, side: "RIGHT" },
              },
            },
          },
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(await gh.requests().catch(() => [])).toEqual([]);
    await runtime.close();
    await store.close();
    store = new Store(join(root, "store.sqlite"));
    runtime = new WorkspaceRuntime(store, root, () => 2, options);
    const read = (repo = repository) =>
      runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "read",
          operation: { op: "forge.pr.review-state", workspaceId, repository: repo, number: 7 },
        }),
      );
    expect(await read()).toMatchObject({
      result: {
        kind: "forge",
        data: {
          resource: "prReviewState",
          value: {
            drafts: [{ body: "Unsent", anchor: { commit: sha, path: "src/main.ts", line: 1 } }],
          },
        },
      },
    });
    expect(await read({ ...repository, name: "other" })).toMatchObject({
      result: { kind: "forge", data: { value: { drafts: [] } } },
    });
  } finally {
    await runtime.close();
    await store.close();
    await gh.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("a lost GitHub review response is reconciled once and clears only accepted drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-hosted-receipt-"));
  const { reviewWriteMarker } = await import("@ace/forge");
  const gh = await fakeGh({
    graphql: [{ body: host }, { body: host }, { body: host }, { body: host }, { body: viewed }],
    "repos/octo/ace/pulls/7/files?per_page=100": [
      { body: [{ filename: "src/main.ts", patch: "@@ -1 +1 @@\n-old\n+new" }] },
    ],
    "repos/octo/ace/pulls/7/reviews": [{ raw: "lost response", code: 1 }],
    "repos/octo/ace/pulls/7/reviews?per_page=100": [
      {
        body: [
          {
            id: 9,
            body: `Reviewed\n\n${reviewWriteMarker("submit")}`,
            commit_id: sha,
            state: "COMMENTED",
            user: { login: "reviewer" },
          },
        ],
      },
    ],
  });
  const store = new Store(join(root, "store.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const runtime = new WorkspaceRuntime(store, root, () => 1, {
    forgeRunner: () => (request) => gh.runner({ ...request, command: gh.executable }),
  });
  const send = (id: string, action: import("@ace/protocol").ForgeReviewAction) =>
    runtime.execute(
      Command.parse({
        id,
        deviceId: "device",
        payload: {
          type: "forge.hosted.review",
          workspaceId,
          pr: { repository, number: 7 },
          action,
        },
      }),
    );
  try {
    await send("save", {
      kind: "draft.save",
      draft: {
        id: "draft",
        body: "Unsent",
        anchor: { commit: sha, path: "src/main.ts", line: 1, side: "RIGHT" },
      },
    });
    const action = {
      kind: "submit",
      event: "COMMENT",
      headSha: sha,
      body: "Reviewed",
      draftIds: ["draft"],
    } as const;
    expect(await send("submit", { ...action, draftIds: [...action.draftIds] })).toMatchObject({
      ok: true,
    });
    expect(await send("submit", { ...action, draftIds: [...action.draftIds] })).toMatchObject({
      ok: true,
    });
    expect(
      await runtime.read(
        WorkspaceActionRequest.parse({
          type: "workspace.request",
          requestId: "state",
          operation: { op: "forge.pr.review-state", workspaceId, repository, number: 7 },
        }),
      ),
    ).toMatchObject({
      result: {
        data: { value: { drafts: [], operations: [{ id: "submit", state: "accepted" }] } },
      },
    });
    expect(
      (await gh.requests()).filter((r) => r.path === "repos/octo/ace/pulls/7/reviews"),
    ).toHaveLength(1);
  } finally {
    await runtime.close();
    await store.close();
    await gh.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
