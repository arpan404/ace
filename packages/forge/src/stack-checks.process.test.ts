import { expect, test } from "vitest";
import { fakeGh, nextSha, sha, stackResponse, thirdSha } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
type Check = { kind: string; name: string; status: string; conclusion: string | null };
const passing = (index: number): Check & { isRequired: boolean } => ({
  kind: "CheckRun",
  name: `Optional lint ${index}`,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  isRequired: false,
});
const layer = (
  headRefOid: string,
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null } = { hasNextPage: false },
) => ({ headRefOid, statusCheckRollup: { contexts: { nodes, pageInfo } } });
const page = (repository: Record<string, unknown>) => ({ body: { data: { repository } } });

test("a required failing check on a later page shows on its layer", async () => {
  const firstPage = Array.from({ length: 20 }, (_, index) => passing(index));
  const f = await fakeGh({
    graphql: [stackResponse()],
    "stack-checks": [
      page({
        pr7: layer(sha, firstPage, { hasNextPage: true, endCursor: "cursor-7" }),
        pr8: layer(nextSha, []),
        pr9: layer(thirdSha, []),
      }),
      page({
        pr7: layer(sha, [
          passing(20),
          {
            kind: "CheckRun",
            name: "Integration",
            status: "COMPLETED",
            conclusion: "FAILURE",
            isRequired: true,
          },
          { kind: "StatusContext", context: "deploy/preview", state: "PENDING", isRequired: true },
        ]),
      }),
    ],
  });
  try {
    const stack = await f.forge.prStack(8, signal());
    expect(stack?.layers[0]).toMatchObject({
      number: 7,
      requiredChecks: [
        { name: "Integration", state: "FAILURE" },
        { name: "deploy/preview", state: "PENDING" },
      ],
      checksTruncated: false,
    });
    const reads = (await f.requests()).filter((request) =>
      String((request.body as { query?: unknown } | undefined)?.query).includes("StackChecks"),
    );
    // The second read asks GitHub for the remaining contexts of the unfinished layer only.
    expect(reads).toHaveLength(2);
    expect(reads[1]?.body).toMatchObject({ variables: { c7: "cursor-7" } });
    expect(String((reads[1]?.body as { query?: string } | undefined)?.query)).not.toContain("pr8:");
  } finally {
    await f.cleanup();
  }
});

test("a layer whose checks outlast the request budget is reported truncated, keeping what was read", async () => {
  const endless = page({
    pr7: layer(
      sha,
      [
        {
          kind: "CheckRun",
          name: "Required build",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          isRequired: true,
        },
      ],
      { hasNextPage: true, endCursor: "again" },
    ),
    pr8: layer(nextSha, []),
    pr9: layer(thirdSha, []),
  });
  const f = await fakeGh({ graphql: [stackResponse()], "stack-checks": [endless] });
  try {
    const stack = await f.forge.prStack(8, signal());
    expect(stack?.layers[0]?.checksTruncated).toBe(true);
    expect(stack?.layers[0]?.requiredChecks[0]).toEqual({
      name: "Required build",
      state: "SUCCESS",
    });
    expect(stack?.layers.slice(1).map((entry) => entry.checksTruncated)).toEqual([false, false]);
  } finally {
    await f.cleanup();
  }
});

test("a head that moves while checks are paged refuses the snapshot", async () => {
  const f = await fakeGh({
    graphql: [stackResponse()],
    "stack-checks": [
      page({
        pr7: layer(sha, [], { hasNextPage: true, endCursor: "cursor-7" }),
        pr8: layer(nextSha, []),
        pr9: layer(thirdSha, []),
      }),
      page({ pr7: layer("f".repeat(40), []) }),
    ],
  });
  try {
    await expect(f.forge.prStack(8, signal())).rejects.toMatchObject({ kind: "conflict" });
  } finally {
    await f.cleanup();
  }
});
