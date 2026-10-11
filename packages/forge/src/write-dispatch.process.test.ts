import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GhApi, GitHubForge, WriteDispatch, createCommandRunner } from "./index.ts";
import { mergeStateResponse, fakeGh, repository, sha, pr } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
for (const failure of ["missing executable", "missing cwd", "permission denied"]) {
  test(`${failure} proves the mutation was unsent and permits a later attempt`, async () => {
    const f = await fakeGh({ "repos/octo/ace/pulls/7/merge": [{ body: { merged: true } }] });
    const cwd = join(f.dir, "cwd");
    await mkdir(cwd);
    const backend = new GitHubForge({
      repository,
      command: f.executable,
      runner: createCommandRunner({
        cwd,
        env: {
          FORGE_FIXTURE: join(f.dir, "fixtures.json"),
          FORGE_STATE: join(f.dir, "state.json"),
        },
      }),
      now: () => 1000,
    });
    try {
      if (failure === "missing executable") await rm(f.executable);
      else if (failure === "missing cwd") await rm(cwd, { recursive: true });
      else await chmod(f.executable, 0o600);
      const dispatch = new WriteDispatch();
      await expect(backend.merge(7, sha, "squash", signal(), dispatch)).rejects.toMatchObject({
        kind: "cli",
        dispatched: false,
      });
      expect(dispatch.definitelyFailed).toBe(true);
      if (failure === "missing cwd") {
        await mkdir(cwd);
        await expect(
          backend.merge(7, sha, "squash", signal(), new WriteDispatch()),
        ).resolves.toBeUndefined();
      }
    } finally {
      await f.cleanup();
    }
  });
}

test("local reply validation leaves dispatch definitely unsent", async () => {
  const f = await fakeGh({});
  try {
    const dispatch = new WriteDispatch();
    await expect(f.forge.replyComment(7, 13, "", signal(), dispatch)).rejects.toThrow();
    expect(dispatch.definitelyFailed).toBe(true);
  } finally {
    await f.cleanup();
  }
});

for (const status of [409, 422]) {
  test(`an HTTP ${status} refusal settles dispatch as failed and permits a later mutation`, async () => {
    const f = await fakeGh({
      "repos/octo/ace/pulls/7/merge": [{ status, code: 1 }, { body: { merged: true } }],
    });
    try {
      const dispatch = new WriteDispatch();
      await expect(f.forge.merge(7, sha, "squash", signal(), dispatch)).rejects.toMatchObject({
        kind: "conflict",
        dispatched: false,
      });
      expect(dispatch.definitelyFailed).toBe(true);
      await expect(
        f.forge.merge(7, sha, "squash", signal(), new WriteDispatch()),
      ).resolves.toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });
}

for (const code of ["RATE_LIMITED", "FORBIDDEN"]) {
  test(`a complete GraphQL ${code} refusal with gh exit 1 is definite failure`, async () => {
    const f = await fakeGh({
      graphql: [
        { code: 1, body: { data: { enablePullRequestAutoMerge: null }, errors: [{ type: code }] } },
      ],
    });
    try {
      const api = new GhApi({
        host: repository.host,
        runner: f.runner,
        command: f.executable,
        now: () => 1000,
      });
      const dispatch = new WriteDispatch();
      await expect(
        api.request(
          "graphql",
          signal(),
          {
            query:
              'mutation { enablePullRequestAutoMerge(input:{pullRequestId:"PR_7"}) { clientMutationId } }',
          },
          "POST",
          dispatch,
        ),
      ).rejects.toMatchObject({
        kind: code === "RATE_LIMITED" ? "rate_limit" : "forbidden",
        dispatched: false,
      });
      expect(dispatch.definitelyFailed).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
}

test("partial GraphQL data and unreadable acknowledgements retain mutation uncertainty", async () => {
  const f = await fakeGh({
    graphql: [
      {
        code: 1,
        body: { data: { firstWrite: { id: "accepted" } }, errors: [{ type: "RATE_LIMITED" }] },
      },
      { raw: "lost acknowledgement" },
    ],
  });
  try {
    const api = new GhApi({
      host: repository.host,
      runner: f.runner,
      command: f.executable,
      now: () => 1000,
    });
    for (const query of ["mutation { firstWrite { id } }", "mutation { secondWrite { id } }"]) {
      const dispatch = new WriteDispatch();
      await expect(api.request("graphql", signal(), { query }, "POST", dispatch)).rejects.toThrow();
      expect(dispatch.definitelyFailed).toBe(false);
    }
  } finally {
    await f.cleanup();
  }
});

for (const failure of ["timeout", "output limit"] as const) {
  test(`auto-merge ${failure} after gh has started preserves dispatch uncertainty`, async () => {
    const f = await fakeGh(
      {
        "repos/octo/ace/pulls/7": [{ body: pr }],
        graphql: [
          mergeStateResponse(),
          failure === "timeout" ? { wait: true } : { repeat: 16, text: "x".repeat(1024) },
          mergeStateResponse(),
        ],
      },
      failure === "timeout" ? { timeoutMs: 5000 } : { maxBytes: 1024 },
    );
    try {
      const dispatch = new WriteDispatch();
      await expect(
        f.forge.enableAutoMerge(7, sha, "squash", signal(), dispatch),
      ).rejects.toMatchObject({ kind: failure === "timeout" ? "cli" : "limit" });
      expect(dispatch.definitelyFailed).toBe(false);
      expect(await f.requests()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "graphql",
            body: expect.objectContaining({
              variables: {
                input: { pullRequestId: "PR_7", expectedHeadOid: sha, mergeMethod: "SQUASH" },
              },
            }),
          }),
        ]),
      );
    } finally {
      await f.cleanup();
    }
  });
}

test("a changed head prevents auto-merge before mutation dispatch", async () => {
  const f = await fakeGh({
    graphql: [mergeStateResponse({ headRefOid: "b".repeat(40) })],
  });
  try {
    const dispatch = new WriteDispatch();
    await expect(
      f.forge.enableAutoMerge(7, sha, "squash", signal(), dispatch),
    ).rejects.toMatchObject({ kind: "conflict", dispatched: false });
    expect(dispatch.definitelyFailed).toBe(true);
    expect(
      (await f.requests()).filter((request) => JSON.stringify(request.body).includes("mutation")),
    ).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
