import "./test-host.ts";
import { WorkspaceId } from "@ace/protocol";
import type { ForgeBrowserResult, ForgePrDetail, ForgePrRow, ForgeRepository } from "@ace/protocol";
import { expect, test } from "vitest";
import { reviewDraftKeys, type HostedFilesReply } from "./forge-hosted.ts";
import type { PullsReply } from "./forge-lists.ts";
import type { PullReply } from "./forge-pull.ts";
import type { ForgeOwner } from "./forge-reads.ts";
import { ForgeRequest, ForgeService } from "./forge-service.ts";
import { plainPreview } from "./sheet-fixture.ts";

/*
 * Reviews on hosts ace only reads (GitLab, Cursor Origin), asked of the phone's forge service
 * with the daemon's forge reads answered at the wire: what the read-only page, its files and
 * its rows say, and which reads reach the daemon.
 */

const gitlab: ForgeRepository = {
  forge: "gitlab",
  host: "gitlab.com",
  owner: "acme/tools",
  name: "ace",
};
const origin: ForgeRepository = {
  forge: "origin",
  host: "origin.cursor.com",
  owner: "acme",
  name: "ace",
};
const head = "a".repeat(40);
const moved = "b".repeat(40);
const base = "c".repeat(40);

function detail(
  repository: ForgeRepository,
  patch: Partial<ForgePrDetail> = {},
  headSha = head,
): ForgePrDetail {
  return {
    readOnly: true,
    status: {
      ref: { repository, number: 7 },
      title: "Tidy the parser",
      url: `https://${repository.host}/${repository.owner}/${repository.name}/-/merge_requests/7`,
      headSha,
      state: "open",
      mergeability: "unknown",
      ci: "unknown",
      checks: [],
      comments: [],
      reviewThreads: [],
      raw: {},
    },
    body: "Fixes #12",
    author: "mira",
    headBranch: "tidy",
    baseBranch: "main",
    baseSha: base,
    headRepository: null,
    labels: [],
    reviewers: [],
    reviewDecision: null,
    commits: 0,
    changedFiles: 0,
    relatedThreads: [],
    relatedThreadsTruncated: false,
    ...patch,
  };
}

const file = (path: string) => ({
  path,
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-a\n+b",
  truncated: false,
});

type Answer = ForgeBrowserResult | { error: string };
type Operation = { op: string; headSha?: string; page?: number };

/** A forge service whose daemon answers each read by `answer`, recording every operation. */
function service(answer: (operation: Operation) => Answer) {
  const ops: Operation[] = [];
  const owner: ForgeOwner = {
    request: (async (request: { operation: Operation }) => {
      ops.push(request.operation);
      const value = answer(request.operation);
      return "error" in value
        ? { result: { kind: "error", code: value.error } }
        : { result: { kind: "forge", data: value } };
    }) as never,
    command: (async () => ({ ok: false, error: "forge_unsupported" })) as never,
    threads: (() => ({ store: { ids: [], thread: () => undefined }, release() {} })) as never,
  };
  const forge = new ForgeService(
    owner,
    plainPreview,
    () => 0,
    () => "",
    () => "draft",
    (async () => {
      throw new Error("no media");
    }) as never,
  );
  const ask = (request: Record<string, unknown>) =>
    forge.answer(ForgeRequest.parse(request), new AbortController().signal);
  return { ask, ops };
}

const pullRead = (repository: ForgeRepository) => ({
  type: "forge.pull",
  project: "ace",
  number: 7,
  repository,
});

test("a GitLab merge request reads as a read-only page: GitLab's words, no controls, no merge-state reads", async () => {
  const { ask, ops } = service(() => ({
    resource: "prDetail",
    value: detail(gitlab, {
      unavailableResources: ["fileCount", "commits"],
      commits: 0,
      changedFiles: 0,
    }),
  }));
  const page = (await ask(pullRead(gitlab))) as PullReply;
  expect(page.hosted).toMatchObject({
    provider: "GitLab",
    noun: "merge request",
    line: "Some review actions are available only on GitLab.",
    filesUnavailable: null,
  });
  // A count the host didn't give is no number at all, never "0 files" or "0 commits".
  expect(page.changedFiles).toBeNull();
  expect(page.commits).toBeNull();
  expect(page).toMatchObject({
    action: null,
    secondary: null,
    primary: "",
    gates: [],
    methods: [],
    commit: null,
    tasks: false,
  });
  expect(ops.map((op) => op.op)).toEqual(["forge.pr.detail"]);
});

test("a known file count shows as a number on a read-only review", async () => {
  const { ask } = service(() => ({
    resource: "prDetail",
    value: detail(origin, { changedFiles: 3, commits: 2 }),
  }));
  const page = (await ask(pullRead(origin))) as PullReply;
  expect(page.hosted?.provider).toBe("Cursor Origin");
  expect(page.hosted?.noun).toBe("pull request");
  expect([page.changedFiles, page.commits]).toEqual([3, 2]);
});

test("an explicit GitHub read-only capability list offers no controls", async () => {
  const github: ForgeRepository = {
    forge: "github",
    host: "github.com",
    owner: "acme",
    name: "ace",
  };
  const { ask, ops } = service(() => ({
    resource: "prDetail",
    value: detail(github, { capabilities: ["reviews.read", "reviews.files"] }),
  }));
  const page = (await ask(pullRead(github))) as PullReply;
  expect(page.hosted?.provider).toBe("GitHub");
  expect(page.action).toBeNull();
  expect(ops.map((op) => op.op)).toEqual(["forge.pr.detail"]);
});

test("#N on GitLab opens the issue on GitLab; on Cursor Origin it opens that review in ace", async () => {
  const lab = service(() => ({ resource: "prDetail", value: detail(gitlab) }));
  const cursor = service(() => ({ resource: "prDetail", value: detail(origin) }));
  expect(((await lab.ask(pullRead(gitlab))) as PullReply).hosted?.links).toEqual({
    issue: "https://gitlab.com/acme/tools/ace/-/issues/{number}",
    review: false,
    commit: "https://gitlab.com/acme/tools/ace/-/commit/{sha}",
    mention: "https://gitlab.com/{login}",
  });
  expect(((await cursor.ask(pullRead(origin))) as PullReply).hosted?.links).toEqual({
    issue: null,
    review: true,
    commit: null,
    mention: null,
  });
});

const filesRead = (patch: Record<string, unknown> = {}) => ({
  type: "forge.pull.hosted-files",
  project: "ace",
  number: 7,
  repository: gitlab,
  ...patch,
});

test("a read-only review's files come a page at a time, with the host's next page", async () => {
  const { ask } = service((op) =>
    op.op === "forge.pr.detail"
      ? { resource: "prDetail", value: detail(gitlab) }
      : {
          resource: "prFiles",
          value: {
            ref: { repository: gitlab, number: 7 },
            baseSha: base,
            headSha: head,
            files: [file(`src/page-${op.page}.ts`)],
            ...(op.page === 1 ? { nextPage: 2 } : {}),
            truncated: op.page === 2,
          },
        },
  );
  const first = (await ask(filesRead())) as HostedFilesReply;
  expect(first).toMatchObject({
    page: 1,
    nextPage: 2,
    moved: false,
    truncated: null,
    headSha: head,
  });
  expect(first.files.map((each) => each.path)).toEqual(["src/page-1.ts"]);
  const second = (await ask(filesRead({ page: 2, headSha: head }))) as HostedFilesReply;
  expect(second).toMatchObject({ page: 2, nextPage: null, moved: false });
  expect(second.truncated).toBe(
    "Some changes are omitted. Open the merge request on GitLab to see the full diff.",
  );
});

test("a branch that moved since the phone looked starts again at page 1 of its new changes", async () => {
  const { ask, ops } = service((op) =>
    op.op === "forge.pr.detail"
      ? { resource: "prDetail", value: detail(gitlab, {}, moved) }
      : {
          resource: "prFiles",
          value: {
            ref: { repository: gitlab, number: 7 },
            baseSha: base,
            headSha: moved,
            files: [file("a.ts")],
            truncated: false,
          },
        },
  );
  const reply = (await ask(filesRead({ page: 3, headSha: head }))) as HostedFilesReply;
  expect(reply).toMatchObject({ page: 1, moved: true, headSha: moved });
  expect(ops.find((op) => op.op === "forge.pr.files")).toMatchObject({ page: 1, headSha: moved });
});

test("a branch that moves while the files read is read again at its new head", async () => {
  let details = 0;
  const { ask } = service((op) => {
    if (op.op === "forge.pr.detail")
      return { resource: "prDetail", value: detail(gitlab, {}, ++details === 1 ? head : moved) };
    if (op.headSha === head) return { error: "forge_head_moved" };
    return {
      resource: "prFiles",
      value: {
        ref: { repository: gitlab, number: 7 },
        baseSha: base,
        headSha: moved,
        files: [file("b.ts")],
        truncated: false,
      },
    };
  });
  const reply = (await ask(filesRead({ page: 2, headSha: head }))) as HostedFilesReply;
  expect(reply).toMatchObject({ page: 1, moved: true, headSha: moved });
  expect(reply.files.map((each) => each.path)).toEqual(["b.ts"]);
});

test("a host that doesn't share files says so instead of an empty list, without reading them", async () => {
  const { ask, ops } = service(() => ({
    resource: "prDetail",
    value: detail(origin, { unavailableResources: ["files"] }),
  }));
  const reply = (await ask(filesRead({ repository: origin }))) as HostedFilesReply;
  expect(reply.unavailable).toBe(
    "Cursor Origin doesn't share this pull request's changed files with ace. Open it on Cursor Origin to see them.",
  );
  expect(reply.files).toEqual([]);
  expect(ops.some((op) => op.op === "forge.pr.files")).toBe(false);
  const page = (await ask(pullRead(origin))) as PullReply;
  expect(page.changedFiles).toBeNull();
});

test("a failed GitLab read names glab, never gh", async () => {
  const { ask } = service(() => ({ error: "forge_cli" }));
  const failure = await ask(pullRead(gitlab)).catch((error: Error) => error.message);
  expect(failure).toContain("glab auth login");
  expect(failure).not.toMatch(/\bgh\b|GitHub/);
});

test("a failed read of the project's own Origin repository names origin, learnt from its checkout", async () => {
  const { ask } = service((op) =>
    op.op === "forge.repository"
      ? { resource: "repository", value: origin }
      : { error: "forge_cli" },
  );
  const failure = await ask({ type: "forge.pull", project: "ace", number: 7 }).catch(
    (error: Error) => error.message,
  );
  expect(failure).toContain("Cursor Origin");
  expect(failure).toContain("origin auth login");
});

function row(
  repository: ForgeRepository,
  number: number,
  patch: Partial<ForgePrRow> = {},
): ForgePrRow {
  return {
    ref: { repository, number },
    title: `Review ${number}`,
    url: `https://${repository.host}/${number}`,
    author: "mira",
    state: "open",
    labels: [],
    updatedAt: "2026-11-01T00:00:00Z",
    ci: "success",
    reviewDecision: "APPROVED",
    headSha: head,
    ...patch,
  };
}

test("hosted rows are never grouped ready to merge: they say their review status is unavailable", async () => {
  const { ask } = service(() => ({
    resource: "prList",
    value: {
      repository: gitlab,
      items: [row(gitlab, 7), row(gitlab, 8, { state: "merged" })],
      total: 2,
      counts: { open: 1, draft: 0, closed: 0, merged: 1 },
      incomplete: false,
      truncated: false,
    },
  }));
  const pulls = (await ask({ type: "forge.pulls", project: "ace", search: {} })) as PullsReply;
  expect(pulls.groups.map((group) => group.id)).not.toContain("merge");
  const rows = pulls.groups.flatMap((group) => group.rows);
  expect(rows.find((each) => each.number === 7)).toMatchObject({
    repository: gitlab,
    host: "GitLab",
    step: null,
    quiet: "Review status unavailable",
    review: null,
    checks: null,
  });
});

test("a review summary is kept per provider and host, with GitHub's older key read as a fallback", () => {
  const github = reviewDraftKeys(
    { forge: "github", host: "github.com", owner: "acme", name: "ace" },
    7,
  );
  const lab = reviewDraftKeys(
    { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" },
    7,
  );
  const enterprise = reviewDraftKeys(
    { forge: "github", host: "git.acme.dev", owner: "acme", name: "ace" },
    7,
  );
  expect(new Set([github.key, lab.key, enterprise.key]).size).toBe(3);
  expect(github.legacy).toBe("ace.forge.review.acme/ace#7");
  // Only GitHub reviews were ever kept under the old key.
  expect(lab.legacy).toBeNull();
});

test("GitLab declared merge and checks reach the full page without granting auto-merge or editing", async () => {
  const capabilities = ["reviews.read", "reviews.files", "reviews.merge", "reviews.checks"];
  const { ask, ops } = service((op) =>
    op.op === "forge.pr.detail"
      ? { resource: "prDetail", value: detail(gitlab, { capabilities }) }
      : { error: "forge_unavailable" },
  );
  const page = (await ask(pullRead(gitlab))) as PullReply;
  expect(new Set(page.capabilities)).toEqual(new Set(capabilities));
  expect(page.action?.kind).toBe("merge");
  expect(page.secondary).toBeNull();
  expect(page.tasks).toBe(false);
  expect(ops.map((op) => op.op)).toEqual(["forge.pr.detail", "forge.pr.merge-state"]);
});

test("an explicit empty GitHub declaration suppresses reads and controls despite legacy defaults", async () => {
  const github = { ...gitlab, forge: "github" as const, host: "github.com" };
  const { ask, ops } = service(() => ({
    resource: "prDetail",
    value: detail(github, { capabilities: [] }),
  }));
  const page = (await ask(pullRead(github))) as PullReply;
  expect(page.capabilities).toEqual([]);
  expect(page.action).toBeNull();
  expect(page.methods).toEqual([]);
  expect(page.primary).toBe("");
  expect(ops.map((op) => op.op)).toEqual(["forge.pr.detail"]);
});

test("read-only comments stay readable without requesting write state, lifecycle or commits", async () => {
  const capabilities = ["reviews.read", "reviews.comments.read"];
  const { ask, ops } = service((op) =>
    op.op === "forge.pr.detail"
      ? {
          resource: "prDetail",
          value: detail(gitlab, {
            capabilities,
            status: {
              ...detail(gitlab).status,
              comments: [
                {
                  kind: "issue",
                  id: 12,
                  author: "mira",
                  body: "Readable discussion",
                  createdAt: "2026-11-10T00:00:00Z",
                  updatedAt: "2026-11-10T00:00:00Z",
                  file: null,
                  line: null,
                  replyTo: null,
                },
              ],
            },
          }),
        }
      : { error: "forge_unavailable" },
  );
  const page = (await ask({ ...pullRead(gitlab), type: "forge.pull.timeline" })) as {
    rows: { comment?: { body: string; edit: boolean } }[];
    box: unknown;
    review: unknown;
    unread: unknown;
  };
  expect(page.rows.some((each) => each.comment?.body === "Readable discussion")).toBe(true);
  expect(page.box).toBeNull();
  expect(page.review).toBeNull();
  expect(page.unread).toBeNull();
  expect(ops.map((op) => op.op)).toEqual(["forge.pr.detail", "forge.pr.activity"]);
});

test("navigation follows declared GitLab issues and inbox while an empty GitHub declaration hides them", async () => {
  for (const [repository, capabilities, expected] of [
    [
      gitlab,
      ["reviews.read", "issues.read", "inbox", "reviews.create"],
      { issues: true, inbox: true, create: true },
    ],
    [
      { ...gitlab, forge: "github", host: "github.com" },
      [],
      { issues: false, inbox: false, create: false },
    ],
  ] as const) {
    const { ask } = service(() => ({
      resource: "repositories",
      value: {
        workspaceId: WorkspaceId.parse("ace"),
        repositories: [
          {
            repository,
            capabilities: [...capabilities],
            source: "remote",
            visible: true,
            available: true,
            primary: true,
          },
        ],
        primary: repository,
        config: null,
      },
    }));
    expect(await ask({ type: "forge.features", project: "ace" })).toEqual(expected);
  }
});

test("comment-write capability supplies a composer without granting approvals or timeline reads", async () => {
  const { ask, ops } = service((op) => {
    if (op.op === "forge.pr.detail")
      return {
        resource: "prDetail",
        value: detail(gitlab, { capabilities: ["reviews.read", "reviews.comments.write"] }),
      };
    if (op.op === "forge.pr.review-state")
      return {
        resource: "prReviewState",
        value: {
          viewer: "reader",
          headSha: head,
          drafts: [],
          viewed: null,
          canReview: true,
          canComment: true,
          resolvableThreads: [],
          operations: [],
        },
      };
    return { error: "forge_unsupported" };
  });
  const page = (await ask({ ...pullRead(gitlab), type: "forge.pull.timeline" })) as {
    box: unknown;
    review: { verdicts: { event: string }[] };
  };
  expect(page.box).toEqual({ off: null });
  expect(page.review.verdicts.map((verdict) => verdict.event)).toEqual(["COMMENT"]);
  expect(ops.map((op) => op.op)).toEqual(["forge.pr.detail", "forge.pr.review-state"]);
});

test("approval-write capability offers verdicts without granting a conversation comment box", async () => {
  const { ask } = service((op) => {
    if (op.op === "forge.pr.detail")
      return {
        resource: "prDetail",
        value: detail(gitlab, { capabilities: ["reviews.read", "reviews.approvals.write"] }),
      };
    if (op.op === "forge.pr.review-state")
      return {
        resource: "prReviewState",
        value: {
          viewer: "reader",
          headSha: head,
          drafts: [],
          viewed: null,
          canReview: true,
          canComment: true,
          resolvableThreads: [],
          operations: [],
        },
      };
    return { error: "forge_unsupported" };
  });
  const page = (await ask({ ...pullRead(gitlab), type: "forge.pull.timeline" })) as {
    box: unknown;
    review: { verdicts: { event: string }[] };
  };
  expect(page.box).toBeNull();
  expect(page.review.verdicts.map((verdict) => verdict.event)).toEqual([
    "APPROVE",
    "REQUEST_CHANGES",
  ]);
});

test("media without its capability is refused before the host resolves any URL", async () => {
  const { ask, ops } = service(() => ({
    resource: "repositories",
    value: {
      workspaceId: WorkspaceId.parse("ace"),
      primary: gitlab,
      config: null,
      repositories: [
        {
          repository: gitlab,
          capabilities: ["reviews.read"],
          source: "remote",
          visible: true,
          available: true,
          primary: true,
        },
      ],
    },
  }));
  expect(
    await ask({
      type: "forge.media",
      project: "ace",
      repository: gitlab,
      url: "https://gitlab.com/acme/image.png",
      role: "image",
    }),
  ).toMatchObject({ state: "unavailable", reason: "Can't be shown here" });
  expect(ops.map((op) => op.op)).toEqual(["forge.repositories"]);
});

test("suggestion application without its capability is refused before issuing a write", async () => {
  const { ask, ops } = service(() => ({
    resource: "repositories",
    value: {
      workspaceId: WorkspaceId.parse("ace"),
      primary: gitlab,
      config: null,
      repositories: [
        {
          repository: gitlab,
          capabilities: ["reviews.comments.write"],
          source: "remote",
          visible: true,
          available: true,
          primary: true,
        },
      ],
    },
  }));
  expect(
    await ask({
      type: "forge.review",
      project: "ace",
      repository: gitlab,
      number: 7,
      action: {
        kind: "suggestions.apply",
        headSha: head,
        commentIds: [12],
        message: "Apply suggestion",
      },
    }),
  ).toMatchObject({
    ok: false,
    uncertain: false,
    message: "Suggested changes aren't supported for this repository.",
  });
  expect(ops.map((op) => op.op)).toEqual(["forge.repositories"]);
});

test("a review thread offers Reply only where the host can reply inside a thread", async () => {
  const comments = ["reviews.read", "reviews.comments.read", "reviews.comments.write"];
  const reviewThread = {
    id: "T1",
    resolved: false,
    outdated: false,
    file: "src/parse.ts",
    line: 3,
    comments: [
      {
        kind: "inline" as const,
        id: 5,
        body: "Rename this?",
        author: "ola",
        file: "src/parse.ts",
        line: 3,
        updatedAt: "2026-10-10T10:00:00Z",
        replyTo: null,
      },
    ],
  };
  for (const [capabilities, canReply] of [
    [comments, false],
    [[...comments, "reviews.comments.reply"], true],
  ] as const) {
    const { ask } = service((op) => {
      if (op.op === "forge.pr.detail") {
        const value = detail(gitlab, { capabilities: [...capabilities] });
        return {
          resource: "prDetail",
          value: {
            ...value,
            status: {
              ...value.status,
              comments: reviewThread.comments,
              reviewThreads: [reviewThread],
            },
          },
        };
      }
      if (op.op === "forge.pr.review-state")
        return {
          resource: "prReviewState",
          value: {
            viewer: "reader",
            headSha: head,
            drafts: [],
            viewed: null,
            canReview: true,
            canComment: true,
            resolvableThreads: [],
            operations: [],
          },
        };
      return { error: "forge_unsupported" };
    });
    const page = (await ask({ ...pullRead(gitlab), type: "forge.pull.timeline" })) as {
      rows: { kind: string; thread?: { id: string; canReply: boolean } }[];
    };
    expect(page.rows.find((row) => row.thread?.id === "T1")?.thread?.canReply).toBe(canReply);
  }
});
