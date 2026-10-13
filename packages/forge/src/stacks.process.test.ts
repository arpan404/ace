import { GitHubForge, WriteDispatch } from "./index.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  fakeGh,
  stackChecksFixture,
  stackUuid,
  stackLayers,
  stackResponse,
  expectedStack,
  localStack,
  nextSha,
  repository,
} from "./testing/fixtures.ts";
const signal = () => new AbortController().signal;
const allowed = () => true;
const pending = {
  body: { status: "pending", details: { uuid: stackUuid, message: "Merge requested" } },
};

test("native stack ordering comes from host positions and shows lower-layer rules and bounded raw fields", async () => {
  const f = await fakeGh({
    ...stackChecksFixture,
    graphql: [
      stackResponse(
        8,
        stackLayers.toReversed().map((pr) => ({ position: pr.position, pullRequest: pr })),
      ),
    ],
  });
  try {
    const stack = await f.forge.prStack(8, signal());
    expect(stack?.layers.map((layer) => layer.number)).toEqual([7, 8, 9]);
    expect(stack).toMatchObject({
      id: "STACK_42",
      trunk: "main",
      layers: [
        { reviewDecision: "APPROVED", requiredChecks: [{ name: "Model tests", state: "SUCCESS" }] },
        {
          checksState: "SUCCESS",
          reviewDecision: "REVIEW_REQUIRED",
          mergeState: "BLOCKED",
          requiredChecks: [{ name: "API tests", state: "SUCCESS" }],
        },
        { checksState: "PENDING", checksTruncated: true },
      ],
    });
    expect(stack?.raw).toMatchObject({
      stack: { data: { repository: { pullRequest: { stack: { future_field: "retained" } } } } },
    });
  } finally {
    await f.cleanup();
  }
});
test("an already pending native merge adopts GitHub's existing UUID for reconciliation", async () => {
  const f = await fakeGh({
    ...stackChecksFixture,
    graphql: [stackResponse()],
    "repos/octo/ace/pulls/8/merge-async": [{ ...pending, status: 409 }],
  });
  try {
    expect(await f.forge.mergeStack(8, expectedStack, "squash", signal(), allowed)).toMatchObject({
      state: "pending",
      uuid: stackUuid,
    });
    expect((await f.requests()).filter((request) => request.args.includes("PUT"))).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
test("a future native 409 result with a validated UUID remains uncertain and recoverable", async () => {
  const f = await fakeGh({
    ...stackChecksFixture,
    graphql: [stackResponse()],
    "repos/octo/ace/pulls/8/merge-async": [
      {
        status: 409,
        code: 1,
        body: {
          status: "future_result",
          details: { uuid: stackUuid, message: "Inspect the existing request" },
          future_field: "retained",
        },
      },
    ],
  });
  try {
    expect(await f.forge.mergeStack(8, expectedStack, "squash", signal(), allowed)).toMatchObject({
      state: "uncertain",
      uuid: stackUuid,
      raw: { future_field: "retained" },
    });
    expect((await f.requests()).filter((r) => r.args.includes("PUT"))).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
test.each([
  { message: "Conflict" },
  {
    status: "pending",
    details: { message: "A pending result without a UUID is not an acknowledgement" },
  },
])(
  "an ordinary native HTTP 409 refuses the write instead of claiming acknowledgement: %j",
  async (body) => {
    const f = await fakeGh({
      ...stackChecksFixture,
      graphql: [stackResponse()],
      "repos/octo/ace/pulls/8/merge-async": [{ status: 409, code: 1, body }],
    });
    try {
      await expect(
        f.forge.mergeStack(8, expectedStack, "squash", signal(), allowed),
      ).rejects.toMatchObject({ kind: "conflict", dispatched: false });
      expect((await f.requests()).filter((r) => r.args.includes("PUT"))).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  },
);
test("a native merge refusal stays visible without reporting success or retrying it", async () => {
  const f = await fakeGh({
    ...stackChecksFixture,
    graphql: [stackResponse()],
    "repos/octo/ace/pulls/8/merge-async": [
      {
        status: 400,
        body: {
          status: "failed",
          details: { message: "GitHub rejected this request." },
          future_field: "retained",
        },
      },
    ],
  });
  try {
    expect(await f.forge.mergeStack(8, expectedStack, "squash", signal(), allowed)).toMatchObject({
      state: "failed",
      message: "GitHub rejected this request.",
      raw: { future_field: "retained" },
    });
    expect((await f.requests()).filter((request) => request.args.includes("PUT"))).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
test("a future host result is retained as uncertain instead of fabricating a known completion", async () => {
  const f = await fakeGh({
    [`repos/octo/ace/pulls/8/merge-async/${stackUuid}`]: [
      {
        body: {
          status: "future_result",
          details: { message: "Inspect GitHub." },
          future_field: "retained",
        },
      },
    ],
  });
  try {
    expect(await f.forge.stackMergeResult(8, stackUuid, signal())).toMatchObject({
      state: "uncertain",
      raw: { status: "future_result", future_field: "retained" },
    });
  } finally {
    await f.cleanup();
  }
});
test("association order does not create a native stack and membership is scoped to repository PR identity", async () => {
  const f = await fakeGh({
    ...stackChecksFixture,
    graphql: [
      {
        body: {
          data: {
            repository: {
              pr9: {
                number: 9,
                stack: { id: "STACK_42", number: 42, baseRefName: "main", size: 3 },
                stackEntry: { position: 3 },
              },
              pr7: {
                number: 7,
                stack: { id: "STACK_42", number: 42, baseRefName: "main", size: 3 },
                stackEntry: { position: 1 },
              },
              pr8: { number: 8, stack: null, stackEntry: null },
            },
          },
        },
      },
    ],
  });
  try {
    expect(await f.forge.stackMemberships([9, 7, 8], signal())).toMatchObject([
      { number: 9, stack: { id: "STACK_42", number: 42, trunk: "main", size: 3, position: 3 } },
      { number: 7, stack: { id: "STACK_42", number: 42, trunk: "main", size: 3, position: 1 } },
      { number: 8, stack: null },
    ]);
  } finally {
    await f.cleanup();
  }
});
test("merging a middle layer submits one expected-head native asynchronous request without bypassing host rules", async () => {
  const f = await fakeGh({
    ...stackChecksFixture,
    graphql: [stackResponse()],
    "repos/octo/ace/pulls/8/merge-async": [pending],
    [`repos/octo/ace/pulls/8/merge-async/${stackUuid}`]: [
      { body: { status: "enqueued", details: { message: "Queued" } } },
    ],
  });
  try {
    expect(await f.forge.mergeStack(8, expectedStack, "squash", signal(), allowed)).toMatchObject({
      state: "pending",
      uuid: stackUuid,
    });
    expect(await f.forge.stackMergeResult(8, stackUuid, signal())).toMatchObject({
      state: "enqueued",
    });
    const writes = (await f.requests()).filter((request) => request.args.includes("PUT"));
    expect(writes).toEqual([
      expect.objectContaining({
        path: "repos/octo/ace/pulls/8/merge-async",
        body: {
          sha: nextSha,
          merge_method: "squash",
          merge_action: "default",
          bypass_rules: false,
        },
      }),
    ]);
  } finally {
    await f.cleanup();
  }
});
test.each(["changed lower head", "removed lower layer", "closed lower layer"])(
  "%s prevents a merge write",
  async (change) => {
    const layers = stackLayers.map((pr) => ({
      position: pr.position,
      pullRequest: {
        ...pr,
        ...(pr.number === 7
          ? change === "changed lower head"
            ? { headRefOid: "f".repeat(40) }
            : change === "closed lower layer"
              ? { state: "CLOSED" }
              : {}
          : {}),
      },
    }));
    const f = await fakeGh({
      ...stackChecksFixture,
      graphql: [
        stackResponse(
          8,
          change === "removed lower layer"
            ? layers
                .slice(1)
                .map((entry, index) => Object.assign({}, entry, { position: index + 1 }))
            : layers,
        ),
      ],
    });
    try {
      await expect(
        f.forge.mergeStack(8, expectedStack, "merge", signal(), allowed),
      ).rejects.toMatchObject({ kind: "conflict" });
      expect((await f.requests()).every((request) => !request.args.includes("PUT"))).toBe(true);
    } finally {
      await f.cleanup();
    }
  },
);
test("rebase conflicts and successful continuations never invoke unsafe stack publication", async () => {
  const f = await fakeGh({
    ...stackChecksFixture,
    graphql: [stackResponse()],
    "stack-view": [{ body: localStack }],
    "stack-rebase": [{ code: 3 }],
    "stack-rebase-continue": [{ code: 0 }],
    "stack-push": [{ code: 0 }],
  });
  try {
    expect(await f.forge.rebaseStack(8, expectedStack, "rebase", signal(), allowed)).toMatchObject({
      state: "conflict",
    });
    expect((await f.requests()).some((request) => request.path === "stack-push")).toBe(false);
    expect(
      await f.forge.rebaseStack(8, expectedStack, "continue", signal(), allowed),
    ).toMatchObject({
      state: "push_partial",
      message: expect.stringContaining("Publication is disabled"),
    });
    expect((await f.requests()).some((request) => request.path === "stack-push")).toBe(false);
  } finally {
    await f.cleanup();
  }
});
test("successful local rebases and retries remain unpublished even when stack push would report success", async () => {
  const f = await fakeGh({
    ...stackChecksFixture,
    graphql: [stackResponse()],
    "stack-view": [{ body: localStack }],
    "stack-rebase": [{ code: 0 }],
    "stack-push": [{ code: 0 }],
    "stack-rebase-abort": [{ code: 0 }],
  });
  try {
    expect(await f.forge.rebaseStack(8, expectedStack, "rebase", signal(), allowed)).toMatchObject({
      state: "push_partial",
    });
    expect(await f.forge.rebaseStack(8, expectedStack, "push", signal(), allowed)).toMatchObject({
      state: "push_partial",
      message: expect.stringContaining("remote SHAs"),
    });
    expect(await f.forge.rebaseStack(8, expectedStack, "abort", signal(), allowed)).toMatchObject({
      state: "aborted",
    });
    expect((await f.requests()).some((request) => request.path === "stack-push")).toBe(false);
  } finally {
    await f.cleanup();
  }
});
test("an unrelated local stack cannot rebase the selected host layers", async () => {
  const f = await fakeGh({
    ...stackChecksFixture,
    graphql: [stackResponse()],
    "stack-view": [{ body: { ...localStack, trunk: "release" } }],
    "stack-rebase": [{ code: 0 }],
  });
  try {
    await expect(
      f.forge.rebaseStack(8, expectedStack, "rebase", signal(), allowed),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect((await f.requests()).some((request) => request.path === "stack-rebase")).toBe(false);
  } finally {
    await f.cleanup();
  }
});
test.each(["FORBIDDEN", "RATE_LIMITED", "GRAPHQL_VALIDATION_FAILED"])(
  "%s host capability failure remains explicit",
  async (type) => {
    const f = await fakeGh({
      ...stackChecksFixture,
      graphql: [{ code: 1, body: { errors: [{ type, message: "Request refused" }] } }],
    });
    try {
      await expect(f.forge.prStack(8, signal())).rejects.toMatchObject({
        kind:
          type === "FORBIDDEN"
            ? "forbidden"
            : type === "RATE_LIMITED"
              ? "rate_limit"
              : "invalid_data",
      });
    } finally {
      await f.cleanup();
    }
  },
);
test("a missing stack CLI leaves rebase unsupported and never fabricates a successful receipt", async () => {
  const f = await fakeGh({
    ...stackChecksFixture,
    graphql: [stackResponse()],
    "stack-view": [{ code: 1 }],
  });
  try {
    await expect(
      f.forge.rebaseStack(8, expectedStack, "rebase", signal(), allowed),
    ).rejects.toMatchObject({ kind: "unsupported" });
  } finally {
    await f.cleanup();
  }
});

test.each(["closed", "closed draft", "queued"])(
  "a %s dependency blocks a local rebase",
  async (state) => {
    const layers = stackLayers.map((pr) => ({
      position: pr.position,
      pullRequest: Object.assign(
        {},
        pr,
        pr.number === 7
          ? state === "closed" || state === "closed draft"
            ? { state: "CLOSED", isDraft: state === "closed draft" }
            : { mergeQueueEntry: { state: "AWAITING_CHECKS" } }
          : {},
      ),
    }));
    const f = await fakeGh({
      ...stackChecksFixture,
      graphql: [stackResponse(8, layers)],
      "stack-view": [{ body: localStack }],
      "stack-rebase": [{ code: 0 }],
      "stack-push": [{ code: 0 }],
    });
    try {
      await expect(
        f.forge.rebaseStack(8, expectedStack, "rebase", signal(), allowed),
      ).rejects.toMatchObject({ kind: "conflict" });
      expect(
        (await f.requests()).some(
          (request) => request.path === "stack-rebase" || request.path === "stack-push",
        ),
      ).toBe(false);
    } finally {
      await f.cleanup();
    }
  },
);

// Both events can happen after the rebase preflight. Neither authorizes publication.
test.each(["collaborator commit", "queue entry"])(
  "%s during a local rebase cannot be overwritten or reported as published",
  async (event) => {
    const changed = stackLayers.map((pr) => ({
      position: pr.position,
      pullRequest: {
        ...pr,
        ...(pr.number === 7
          ? event === "collaborator commit"
            ? { headRefOid: "f".repeat(40) }
            : { mergeQueueEntry: { state: "AWAITING_CHECKS" } }
          : {}),
      },
    }));
    const [checks] = stackChecksFixture["stack-checks"];
    if (!checks) throw new Error("Missing stack checks fixture");
    // Check rollups are read at the head the host reports, so they follow the new commit.
    const changedChecks = structuredClone(checks);
    if (event === "collaborator commit")
      changedChecks.body.data.repository.pr7.headRefOid = "f".repeat(40);
    const f = await fakeGh({
      "stack-checks": [checks, changedChecks],
      graphql: [stackResponse(), stackResponse(8, changed)],
      "stack-view": [{ body: localStack }],
      "stack-rebase": [{ code: 0, barrier: "release-rebase" }],
      // The unsafe CLI would fetch and accept the new tip or skip the queued branch.
      "stack-push": [{ code: 0 }],
    });
    let rebase: ReturnType<typeof f.forge.rebaseStack> | undefined;
    try {
      rebase = f.forge.rebaseStack(8, expectedStack, "rebase", signal(), allowed);
      await vi.waitFor(async () =>
        expect((await f.requests()).some((r) => r.path === "stack-rebase")).toBe(true),
      );
      const host = await f.forge.prStack(8, signal());
      expect(host?.layers[0]).toMatchObject(
        event === "collaborator commit"
          ? { headSha: "f".repeat(40) }
          : { queueState: "AWAITING_CHECKS" },
      );
      await writeFile(join(f.dir, "release-rebase"), "");
      expect(await rebase).toMatchObject({
        state: "push_partial",
        message: expect.stringContaining("No push was attempted"),
      });
      expect((await f.requests()).some((r) => r.path === "stack-push")).toBe(false);
    } finally {
      await writeFile(join(f.dir, "release-rebase"), "");
      await rebase?.catch(() => {});
      await f.cleanup();
    }
  },
);

test.each(["CLOSED", "MERGED"])(
  "a draft flag cannot hide a %s dependency's terminal state",
  async (state) => {
    const f = await fakeGh({
      ...stackChecksFixture,
      graphql: [
        stackResponse(
          8,
          stackLayers.map((pr) => ({
            position: pr.position,
            pullRequest: { ...pr, ...(pr.number === 7 ? { state, isDraft: true } : {}) },
          })),
        ),
      ],
    });
    try {
      expect((await f.forge.prStack(8, signal()))?.layers[0]?.state).toBe(state);
    } finally {
      await f.cleanup();
    }
  },
);

test("recorded PR queue facts can be read without native stack membership", async () => {
  const f = await fakeGh({
    "stack-scope": [
      {
        body: {
          data: {
            repository: {
              pr7: {
                number: 7,
                state: "MERGED",
                isDraft: true,
                mergeQueueEntry: null,
                future: "kept",
              },
              pr8: {
                number: 8,
                state: "OPEN",
                isDraft: false,
                mergeQueueEntry: { state: "AWAITING_CHECKS" },
              },
            },
          },
        },
      },
    ],
  });
  try {
    expect(await f.forge.stackMergeScope([7, 8], signal())).toMatchObject([
      { number: 7, state: "MERGED", queueState: null, raw: { future: "kept" } },
      { number: 8, state: "OPEN", queueState: "AWAITING_CHECKS" },
    ]);
  } finally {
    await f.cleanup();
  }
});

test("a native 409 acknowledgement cannot lose its uncertainty when the mutation identity changes", async () => {
  const f = await fakeGh({
    ...stackChecksFixture,
    graphql: [stackResponse()],
    "repos/octo/ace/pulls/8/merge-async": [{ ...pending, status: 409, code: 1 }],
  });
  const backend = new GitHubForge({
    repository,
    now: () => 1000,
    runner: async (request) => {
      const result = await f.runner({ ...request, command: f.executable });
      return request.args.includes("PUT") ? { ...result, identityChanged: true } : result;
    },
  });
  const dispatch = new WriteDispatch();
  try {
    await expect(
      backend.mergeStack(8, expectedStack, "squash", signal(), allowed, dispatch),
    ).rejects.toMatchObject({ kind: "outcome_uncertain" });
    expect(dispatch.definitelyFailed).toBe(false);
  } finally {
    await f.cleanup();
  }
});
