import { expect, test } from "vitest";
import { ForgeInboxQuery } from "@ace/protocol/forge-inbox";
import { ForgeError, GitHubInbox, WriteDispatch } from "./index.ts";
import { fakeGh, type Fixtures } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const firstPage = "notifications?all=false&participating=false&per_page=50&page=1";
const api = "https://api.github.com/repos";

function notification(
  id: string,
  type: string,
  reason: string,
  url: string | null,
  repo = "ace",
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    unread: true,
    reason,
    updated_at: "2026-10-22T09:00:00Z",
    last_read_at: null,
    subject: { title: `${type} ${id}`, url, type },
    repository: {
      name: repo,
      owner: { login: "acme" },
      html_url: `https://github.com/acme/${repo}`,
    },
    ...extra,
  };
}

async function inbox(fixtures: Fixtures, clock = { now: 1_000 }) {
  const gh = await fakeGh(fixtures);
  const reader = new GitHubInbox({
    runner: gh.runner,
    command: gh.executable,
    host: "github.com",
    now: () => clock.now,
  });
  return { gh, reader, clock };
}

test("every reason and subject type becomes a row, with its number, state and GitHub address", async () => {
  const { gh, reader } = await inbox({
    [firstPage]: [
      {
        body: [
          notification("1", "PullRequest", "review_requested", `${api}/acme/ace/pulls/229`),
          notification("2", "Issue", "mention", `${api}/acme/docs-site/issues/31`, "docs-site"),
          notification("3", "Release", "subscribed", `${api}/acme/ace/releases/9001`),
          notification("4", "CheckSuite", "ci_activity", null),
          notification("5", "Commit", "comment", `${api}/acme/ace/commits/abc1234def`),
          notification("6", "Discussion", "team_mention", null),
          notification("7", "FutureThing", "approval_requested", null, "ace", { unread: false }),
          { id: "8", reason: "mention" },
        ],
      },
    ],
    "graphql:InboxStates": [
      {
        body: {
          data: {
            r0: { n229: { __typename: "PullRequest", state: "OPEN", isDraft: true } },
            r1: { n31: { __typename: "Issue", state: "CLOSED" } },
          },
        },
      },
    ],
  });
  try {
    const list = await reader.list(ForgeInboxQuery.parse({}), signal());
    expect(
      list.items.map(({ id, type, reason, number, state, url, unread }) => ({
        id,
        type,
        reason,
        number,
        state,
        url,
        unread,
      })),
    ).toEqual([
      {
        id: "1",
        type: "PullRequest",
        reason: "review_requested",
        number: 229,
        state: "draft",
        url: "https://github.com/acme/ace/pull/229",
        unread: true,
      },
      {
        id: "2",
        type: "Issue",
        reason: "mention",
        number: 31,
        state: "closed",
        url: "https://github.com/acme/docs-site/issues/31",
        unread: true,
      },
      {
        id: "3",
        type: "Release",
        reason: "subscribed",
        number: undefined,
        state: undefined,
        url: "https://github.com/acme/ace/releases",
        unread: true,
      },
      {
        id: "4",
        type: "CheckSuite",
        reason: "ci_activity",
        number: undefined,
        state: undefined,
        url: "https://github.com/acme/ace/actions",
        unread: true,
      },
      {
        id: "5",
        type: "Commit",
        reason: "comment",
        number: undefined,
        state: undefined,
        url: "https://github.com/acme/ace/commit/abc1234def",
        unread: true,
      },
      {
        id: "6",
        type: "Discussion",
        reason: "team_mention",
        number: undefined,
        state: undefined,
        url: "https://github.com/acme/ace/discussions",
        unread: true,
      },
      {
        id: "7",
        type: "FutureThing",
        reason: "approval_requested",
        number: undefined,
        state: undefined,
        url: "https://github.com/acme/ace",
        unread: false,
      },
    ]);
    expect(list.items[1]?.repository).toEqual({
      forge: "github",
      host: "github.com",
      owner: "acme",
      name: "docs-site",
    });
  } finally {
    await gh.cleanup();
  }
});

test("rows still arrive without states when GitHub refuses the state read", async () => {
  const { gh, reader } = await inbox({
    [firstPage]: [
      { body: [notification("1", "PullRequest", "author", `${api}/acme/ace/pulls/229`)] },
    ],
    "graphql:InboxStates": [{ status: 403, body: { message: "Must have admin rights" } }],
  });
  try {
    const list = await reader.list(ForgeInboxQuery.parse({}), signal());
    expect(list.items).toMatchObject([{ id: "1", number: 229 }]);
    expect(list.items[0]?.state).toBeUndefined();
  } finally {
    await gh.cleanup();
  }
});

test("an inbox waits GitHub's poll interval, then asks conditionally and keeps its rows on 304", async () => {
  const { gh, reader, clock } = await inbox({
    [firstPage]: [
      {
        headers: { "Last-Modified": "Thu, 22 Oct 2026 09:00:00 GMT", "X-Poll-Interval": "30" },
        body: [notification("1", "PullRequest", "mention", `${api}/acme/ace/pulls/229`)],
      },
      { status: 304, headers: { "X-Poll-Interval": "120" }, raw: "" },
    ],
    "graphql:InboxStates": [
      { body: { data: { r0: { n229: { __typename: "PullRequest", state: "MERGED" } } } } },
    ],
  });
  try {
    const first = await reader.list(ForgeInboxQuery.parse({}), signal());
    expect(first).toMatchObject({ pollSeconds: 30, unchanged: false });
    clock.now += 29_000;
    expect(await reader.list(ForgeInboxQuery.parse({}), signal())).toMatchObject({
      unchanged: true,
      items: [{ id: "1", state: "merged" }],
    });
    expect((await gh.requests()).filter((r) => r.path === firstPage)).toHaveLength(1);
    clock.now += 2_000;
    const again = await reader.list(ForgeInboxQuery.parse({}), signal());
    expect(again).toMatchObject({
      unchanged: true,
      pollSeconds: 120,
      items: [{ id: "1", state: "merged" }],
    });
    const requests = await gh.requests();
    const reads = requests.filter((r) => r.path === firstPage);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.args).toContain("If-Modified-Since: Thu, 22 Oct 2026 09:00:00 GMT");
    expect(requests.filter((r) => r.path === "graphql")).toHaveLength(1);
  } finally {
    await gh.cleanup();
  }
});

test("filters reach GitHub: read ones, participating only, one repository, since and pages", async () => {
  const path =
    "repos/acme/ace/notifications?all=true&participating=true&per_page=50&page=2&since=2026-10-01T00%3A00%3A00Z";
  const { gh, reader } = await inbox({
    [path]: [
      {
        headers: {
          Link: `<https://api.github.com/repos/acme/ace/notifications?all=true&page=3>; rel="next"`,
        },
        body: [],
      },
    ],
  });
  try {
    const list = await reader.list(
      ForgeInboxQuery.parse({
        all: true,
        participating: true,
        page: 2,
        since: "2026-10-01T00:00:00Z",
        repository: { forge: "github", host: "github.com", owner: "acme", name: "ace" },
      }),
      signal(),
    );
    expect(list).toMatchObject({ items: [], nextPage: 3 });
  } finally {
    await gh.cleanup();
  }
});

test("a token that can't read notifications fails with its own category", async () => {
  const { gh, reader } = await inbox({
    [firstPage]: [
      { status: 403, body: { message: "Resource not accessible by personal access token" } },
    ],
  });
  try {
    await expect(reader.list(ForgeInboxQuery.parse({}), signal())).rejects.toMatchObject({
      kind: "notifications_unavailable",
    });
  } finally {
    await gh.cleanup();
  }
});

test("each write sends its own request, and the next read asks GitHub at once", async () => {
  const { gh, reader } = await inbox({
    [firstPage]: [{ headers: { "X-Poll-Interval": "60" }, body: [] }],
    "notifications/threads/1": [{ status: 205, raw: "" }],
    "notifications/threads/2": [{ status: 204, raw: "" }],
    "notifications/threads/3/subscription": [{ status: 204, raw: "" }],
    notifications: [{ status: 205, raw: "" }],
    "repos/acme/ace/notifications": [{ status: 202, body: { message: "queued" } }],
  });
  try {
    await reader.list(ForgeInboxQuery.parse({}), signal());
    await reader.write({ action: "read", id: "1" }, signal());
    await reader.write({ action: "done", id: "2" }, signal());
    await reader.write({ action: "unsubscribe", id: "3" }, signal());
    await reader.write({ action: "read-all", before: "2026-10-22T10:00:00Z" }, signal());
    await reader.write(
      {
        action: "read-all",
        before: "2026-10-22T10:00:00Z",
        repository: { forge: "github", host: "github.com", owner: "acme", name: "ace" },
      },
      signal(),
    );
    await reader.list(ForgeInboxQuery.parse({}), signal());
    const sent = (await gh.requests()).map((r) => ({
      path: r.path,
      method: r.args[r.args.indexOf("--method") + 1],
      body: r.body,
    }));
    expect(sent).toEqual([
      { path: firstPage, method: "GET", body: undefined },
      { path: "notifications/threads/1", method: "PATCH", body: undefined },
      { path: "notifications/threads/2", method: "DELETE", body: undefined },
      { path: "notifications/threads/3/subscription", method: "DELETE", body: undefined },
      {
        path: "notifications",
        method: "PUT",
        body: { last_read_at: "2026-10-22T10:00:00Z", read: true },
      },
      {
        path: "repos/acme/ace/notifications",
        method: "PUT",
        body: { last_read_at: "2026-10-22T10:00:00Z", read: true },
      },
      { path: firstPage, method: "GET", body: undefined },
    ]);
  } finally {
    await gh.cleanup();
  }
});

test("a refused write is a definite failure, not an uncertain one", async () => {
  const { gh, reader } = await inbox({
    "notifications/threads/1": [{ status: 403, body: { message: "Forbidden" } }],
  });
  try {
    const dispatch = new WriteDispatch();
    const error: unknown = await reader
      .write({ action: "done", id: "1" }, signal(), dispatch)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ kind: "notifications_unavailable" });
    expect(dispatch.definitelyFailed).toBe(true);
  } finally {
    await gh.cleanup();
  }
});

test("after a refused state read, the next poll asks for states again though the notifications didn't change", async () => {
  const { gh, reader, clock } = await inbox({
    [firstPage]: [
      {
        headers: { "Last-Modified": "Thu, 22 Oct 2026 09:00:00 GMT", "X-Poll-Interval": "30" },
        body: [notification("1", "PullRequest", "mention", `${api}/acme/ace/pulls/229`)],
      },
      { status: 304, raw: "" },
    ],
    "graphql:InboxStates": [
      { status: 403, headers: { "Retry-After": "1" }, body: { message: "secondary rate limit" } },
      { body: { data: { r0: { n229: { __typename: "PullRequest", state: "MERGED" } } } } },
    ],
  });
  try {
    const first = await reader.list(ForgeInboxQuery.parse({}), signal());
    expect(first.items[0]?.state).toBeUndefined();
    clock.now += 31_000;
    const again = await reader.list(ForgeInboxQuery.parse({}), signal());
    expect(again).toMatchObject({ unchanged: true, items: [{ id: "1", state: "merged" }] });
  } finally {
    await gh.cleanup();
  }
});

test("a rate limit holds every read until GitHub's reset, without asking again", async () => {
  const { gh, reader, clock } = await inbox({
    [firstPage]: [
      {
        status: 403,
        headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "120" },
        body: { message: "API rate limit exceeded" },
      },
      { body: [] },
    ],
  });
  try {
    await expect(reader.list(ForgeInboxQuery.parse({}), signal())).rejects.toMatchObject({
      kind: "rate_limit",
    });
    clock.now = 60_000;
    await expect(reader.list(ForgeInboxQuery.parse({}), signal())).rejects.toMatchObject({
      kind: "rate_limit",
    });
    expect((await gh.requests()).filter((r) => r.path === firstPage)).toHaveLength(1);
    clock.now = 121_000;
    expect(await reader.list(ForgeInboxQuery.parse({}), signal())).toMatchObject({ items: [] });
    expect((await gh.requests()).filter((r) => r.path === firstPage)).toHaveLength(2);
  } finally {
    await gh.cleanup();
  }
});

test("a sign-in that is gone, or a refusal for one repository, keeps its own category", async () => {
  const repoPage =
    "repos/acme/secret/notifications?all=false&participating=false&per_page=50&page=1";
  const { gh, reader } = await inbox({
    [firstPage]: [
      { status: 401, body: { message: "Bad credentials" } },
      { offline: true, code: 4 },
    ],
    [repoPage]: [{ status: 403, body: { message: "Resource not accessible" } }],
  });
  try {
    for (let read = 0; read < 2; read++)
      await expect(reader.list(ForgeInboxQuery.parse({}), signal())).rejects.toMatchObject({
        kind: "forbidden",
      });
    await expect(
      reader.list(
        ForgeInboxQuery.parse({
          repository: { forge: "github", host: "github.com", owner: "acme", name: "secret" },
        }),
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
  } finally {
    await gh.cleanup();
  }
});

test("a read that was on its way when a write landed isn't repeated: the next read asks GitHub", async () => {
  const { gh, reader } = await inbox({
    [firstPage]: [
      {
        barrier: "held-read",
        headers: { "X-Poll-Interval": "60" },
        body: [notification("1", "Issue", "assign", `${api}/acme/ace/issues/240`)],
      },
      { headers: { "X-Poll-Interval": "60" }, body: [] },
    ],
    "notifications/threads/1": [{ status: 204, raw: "" }],
    "graphql:InboxStates": [
      { body: { data: { r0: { n240: { __typename: "Issue", state: "OPEN" } } } } },
    ],
  });
  try {
    const held = reader.list(ForgeInboxQuery.parse({}), signal());
    await gh.waitForRequest(firstPage);
    await reader.write({ action: "done", id: "1" }, signal());
    await gh.release("held-read");
    // GitHub answered from before the write; that answer is never kept.
    expect((await held).items.map((row) => row.id)).toEqual(["1"]);
    expect(await reader.list(ForgeInboxQuery.parse({}), signal())).toMatchObject({
      items: [],
      unchanged: false,
    });
    expect((await gh.requests()).filter((r) => r.path === firstPage)).toHaveLength(2);
  } finally {
    await gh.cleanup();
  }
});

test("a state read GitHub refuses for good is not asked again on every poll", async () => {
  const { gh, reader, clock } = await inbox({
    [firstPage]: [
      {
        headers: { "Last-Modified": "Thu, 22 Oct 2026 09:00:00 GMT", "X-Poll-Interval": "30" },
        body: [notification("1", "PullRequest", "mention", `${api}/acme/gone/pulls/3`, "gone")],
      },
      { status: 304, raw: "" },
    ],
    "graphql:InboxStates": [
      {
        body: {
          data: { r0: null },
          errors: [{ type: "NOT_FOUND", path: ["r0"], message: "Could not resolve" }],
        },
      },
    ],
  });
  try {
    await reader.list(ForgeInboxQuery.parse({}), signal());
    clock.now += 31_000;
    const again = await reader.list(ForgeInboxQuery.parse({}), signal());
    expect(again).toMatchObject({ unchanged: true, items: [{ id: "1" }] });
    expect(again.items[0]?.state).toBeUndefined();
    expect((await gh.requests()).filter((r) => r.path === "graphql")).toHaveLength(1);
  } finally {
    await gh.cleanup();
  }
});
