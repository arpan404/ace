import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Command, ForgeReviewDraft, WorkspaceActionRequest } from "@ace/protocol";
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
    "graphql:viewer { login }": [{ body: host }],
    "graphql:files(first:": [{ body: viewed }],
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
    "graphql:viewer { login }": [{ body: host }],
    "graphql:files(first:": [{ body: viewed }],
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

test("after a push, a pending draft follows its shifted line into the review and one on a changed line posts on its file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-hosted-move-"));
  const { nextSha } = await import("@ace/forge/testing");
  const old = nextSha;
  const context = Array.from({ length: 9 }, (_, i) => ` line ${i + 1}`).join("\n");
  const gh = await fakeGh({
    "graphql:viewer { login }": [{ body: host }],
    "graphql:files(first:": [{ body: viewed }],
    "repos/octo/ace/pulls/7/files?per_page=100": [
      { body: [{ filename: "src/main.ts", patch: `@@ -1,9 +1,9 @@\n${context}` }] },
    ],
    // Since the draft's commit: a line added above line 5, and line 8 rewritten.
    [`repos/octo/ace/compare/${old}...${sha}`]: [
      {
        body: {
          status: "ahead",
          commits: [{ parents: [{ sha: old }] }],
          files: [
            {
              filename: "src/main.ts",
              status: "modified",
              patch:
                "@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -7,2 +8,2 @@\n seven\n-const total = 1;\n+const total = 2;",
            },
          ],
        },
      },
    ],
    "repos/octo/ace/pulls/7/comments": [
      { body: { id: 31, body: "posted", user: { login: "reviewer" } } },
    ],
    "repos/octo/ace/pulls/7/reviews": [
      {
        body: {
          id: 9,
          body: "ok",
          commit_id: sha,
          state: "COMMENTED",
          user: { login: "reviewer" },
        },
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
  const drafts = async () => {
    const read = await runtime.read(
      WorkspaceActionRequest.parse({
        type: "workspace.request",
        requestId: "state",
        operation: { op: "forge.pr.review-state", workspaceId, repository, number: 7 },
      }),
    );
    return z
      .looseObject({
        result: z.looseObject({
          data: z.looseObject({ value: z.looseObject({ drafts: z.array(ForgeReviewDraft) }) }),
        }),
      })
      .parse(read).result.data.value.drafts;
  };
  try {
    for (const [id, line] of [
      ["shifted", 5],
      ["changed", 8],
    ] as const)
      await send(`save-${id}`, {
        kind: "draft.save",
        draft: {
          id,
          body: `On ${line}`,
          anchor: { commit: old, path: "src/main.ts", line, side: "RIGHT" },
        },
      });
    const submit = { kind: "submit", event: "COMMENT", headSha: sha, body: "Reviewed" } as const;
    // The changed line can't follow: the review is refused and nothing is lost.
    expect(await send("submit-all", { ...submit, draftIds: ["shifted", "changed"] })).toMatchObject(
      {
        ok: false,
      },
    );
    expect(await drafts()).toEqual([
      {
        id: "changed",
        body: "On 8",
        anchor: { commit: old, path: "src/main.ts", line: 8, side: "RIGHT" },
        outdated: { headSha: sha, code: ["seven", "const total = 1;"] },
      },
      {
        id: "shifted",
        body: "On 5",
        anchor: { commit: sha, path: "src/main.ts", line: 6, side: "RIGHT" },
      },
    ]);
    expect(await send("file", { kind: "draft.file", id: "changed", headSha: sha })).toMatchObject({
      ok: true,
    });
    expect(await send("submit", { ...submit, draftIds: ["shifted"] })).toMatchObject({ ok: true });
    expect(await drafts()).toEqual([]);
    const posted = (await gh.requests()).filter(
      (r) =>
        r.path === "repos/octo/ace/pulls/7/comments" || r.path === "repos/octo/ace/pulls/7/reviews",
    );
    expect(posted.map((r) => r.body)).toMatchObject([
      {
        path: "src/main.ts",
        subject_type: "file",
        body: expect.stringContaining("const total = 1;"),
      },
      { commit_id: sha, comments: [{ path: "src/main.ts", line: 6, side: "RIGHT", body: "On 5" }] },
    ]);
  } finally {
    await runtime.close();
    await store.close();
    await gh.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("a draft posted on its file whose answer was lost is removed once found, even after another push", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-hosted-fence-"));
  const { nextSha } = await import("@ace/forge/testing");
  const { reviewWriteMarker } = await import("@ace/forge");
  const old = nextSha;
  const later = "c".repeat(40);
  const posted = {
    id: 31,
    body: `quoted\n\n${reviewWriteMarker("file")}`,
    path: "src/main.ts",
    user: { login: "reviewer" },
  };
  const pull = host.data.repository.pullRequest;
  const at = (head: string) => ({
    body: { data: { ...host.data, repository: { pullRequest: { ...pull, headRefOid: head } } } },
  });
  const viewedLater = {
    data: {
      repository: { pullRequest: { ...viewed.data.repository.pullRequest, headRefOid: later } },
    },
  };
  const gh = await fakeGh({
    // The post and its first look at the head it was made on; then someone pushes.
    "graphql:viewer { login }": [at(sha), at(sha), at(later)],
    "graphql:files(first:": [{ body: viewedLater }],
    "repos/octo/ace/pulls/7/files?per_page=100": [
      { body: [{ filename: "src/main.ts", patch: "@@ -1,2 +1,2 @@\n a\n-b\n+c" }] },
    ],
    // Another push after the post: line 8 changed again, so the draft would move.
    [`repos/octo/ace/compare/${old}...${later}`]: [
      {
        body: {
          status: "ahead",
          commits: [{ parents: [{ sha: old }] }],
          files: [
            {
              filename: "src/main.ts",
              status: "modified",
              patch: "@@ -7,2 +7,2 @@\n seven\n-const total = 1;\n+const total = 3;",
            },
          ],
        },
      },
    ],
    // GitHub took the post, but its answer never came back.
    "repos/octo/ace/pulls/7/comments": [{ status: 502 }],
    // The first look misses it; a later one finds it.
    "repos/octo/ace/pulls/7/comments?per_page=100": [{ body: [] }, { body: [posted] }],
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
  const state = async () =>
    z
      .looseObject({
        result: z.looseObject({
          data: z.looseObject({
            value: z.looseObject({
              drafts: z.array(ForgeReviewDraft),
              operations: z.array(z.looseObject({ id: z.string(), state: z.string() })),
            }),
          }),
        }),
      })
      .parse(
        await runtime.read(
          WorkspaceActionRequest.parse({
            type: "workspace.request",
            requestId: "state",
            operation: { op: "forge.pr.review-state", workspaceId, repository, number: 7 },
          }),
        ),
      ).result.data.value;
  try {
    await send("save", {
      kind: "draft.save",
      draft: {
        id: "changed",
        body: "On 8",
        anchor: { commit: old, path: "src/main.ts", line: 8, side: "RIGHT" },
        outdated: { headSha: sha, code: ["seven", "const total = 1;"] },
      },
    });
    expect(await send("file", { kind: "draft.file", id: "changed", headSha: sha })).toMatchObject({
      ok: false,
      error: "action_outcome_uncertain",
    });
    expect(await send("move", { kind: "drafts.move", headSha: later })).toMatchObject({ ok: true });
    expect(await send("reconcile", { kind: "reconcile", operationId: "file" })).toMatchObject({
      ok: true,
    });
    expect(await state()).toMatchObject({
      drafts: [],
      operations: [{ id: "file", state: "accepted" }],
    });
    const posts = (await gh.requests()).filter((r) => r.path === "repos/octo/ace/pulls/7/comments");
    expect(posts).toHaveLength(1);
  } finally {
    await runtime.close();
    await store.close();
    await gh.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
