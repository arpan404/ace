import "./test-host.ts";
import {
  WorkspaceId,
  type ForgeBrowserResult,
  type ForgeIssueRow,
  type ForgePrRow,
  type ForgeRepository,
  type ProjectRepositories,
} from "@ace/protocol";
import { expect, test } from "vitest";
import type { IssuesReply, PullsReply } from "./forge-lists.ts";
import type { ForgeOwner } from "./forge-reads.ts";
import { ForgeRequest, ForgeService } from "./forge-service.ts";
import { plainPreview } from "./sheet-fixture.ts";

/*
 * A project with several repositories (ADR 0116) in the phone's Pull requests and Issues: every
 * visible, available repository is read and shown as one list, rows say which repository they
 * are from, and one repository failing leaves the others on screen. The daemon is answered at
 * the wire.
 */

const github: ForgeRepository = { forge: "github", host: "github.com", owner: "acme", name: "ace" };
const gitlab: ForgeRepository = { forge: "gitlab", host: "gitlab.com", owner: "acme", name: "ace" };
const hidden: ForgeRepository = { forge: "github", host: "github.com", owner: "acme", name: "old" };

const entry = (
  repository: ForgeRepository,
  patch: Partial<ProjectRepositories["repositories"][number]> = {},
) => ({
  repository,
  source: "remote" as const,
  remote: repository.forge === "github" ? "origin" : "mirror",
  visible: true,
  primary: false,
  available: true,
  ...patch,
});

const repositories = (...list: ProjectRepositories["repositories"]): ForgeBrowserResult => ({
  resource: "repositories",
  value: {
    workspaceId: WorkspaceId.parse("ace"),
    repositories: list,
    primary: list.find((each) => each.primary)?.repository ?? null,
    config: null,
  },
});

function pr(repository: ForgeRepository, number: number, updatedAt: string): ForgePrRow {
  return {
    ref: { repository, number },
    title: `Change ${number}`,
    url: `https://${repository.host}/${repository.owner}/${repository.name}/${number}`,
    author: "mira",
    state: "open",
    labels: [],
    updatedAt,
  };
}

function issue(repository: ForgeRepository, number: number, updatedAt: string): ForgeIssueRow {
  return {
    ref: { repository, number },
    title: `Issue ${number}`,
    url: `https://${repository.host}/${repository.owner}/${repository.name}/issues/${number}`,
    author: "mira",
    state: "open",
    labels: [],
    assignees: [],
    milestone: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

const prList = (
  repository: ForgeRepository,
  items: ForgePrRow[],
  nextPage?: number,
): ForgeBrowserResult => ({
  resource: "prList",
  value: {
    repository,
    items,
    total: items.length,
    ...(nextPage ? { nextPage } : {}),
    counts: { open: items.length, draft: 0, closed: 1, merged: 2 },
    incomplete: false,
    truncated: false,
  },
});

type Operation = { op: string; repository?: ForgeRepository; query?: { page?: number } };
type Answer = ForgeBrowserResult | { error: string };

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

const updated = { type: "forge.pulls", project: "ace", search: { sort: "updated" } };
const rowsOf = (reply: PullsReply | IssuesReply) =>
  reply.groups.flatMap((group) =>
    group.rows.map((row) => `${row.repositoryLabel ?? "-"} #${row.number}`),
  );

test("pull requests from every visible repository show as one list, newest first, each row naming its repository", async () => {
  const { ask, ops } = service((op) => {
    if (op.op === "forge.repositories")
      return repositories(
        entry(github, { primary: true }),
        entry(gitlab),
        entry(hidden, { visible: false }),
      );
    if (op.op === "forge.group-counts") return { resource: "groupCounts", counts: {} };
    if (op.repository?.forge === "gitlab")
      return prList(gitlab, [pr(gitlab, 5, "2026-11-03T00:00:00Z")]);
    return prList(github, [
      pr(github, 9, "2026-11-04T00:00:00Z"),
      pr(github, 2, "2026-11-01T00:00:00Z"),
    ]);
  });
  const reply = (await ask(updated)) as PullsReply;
  expect(rowsOf(reply)).toEqual([
    "GitHub · acme/ace #9",
    "GitLab · acme/ace #5",
    "GitHub · acme/ace #2",
  ]);
  // Each state's count is the repositories' together.
  expect(reply.counts).toEqual({ open: 3, merged: 4, closed: 2 });
  expect(reply.failed).toEqual([]);
  // The hidden repository is never read.
  const listed = ops.filter((op) => op.op === "forge.pr.list").map((op) => op.repository?.name);
  expect(listed).not.toContain("old");
});

test("one repository failing leaves the other's pull requests on screen and says which one failed", async () => {
  const { ask } = service((op) => {
    if (op.op === "forge.repositories")
      return repositories(entry(github, { primary: true }), entry(gitlab));
    if (op.op === "forge.group-counts") return { resource: "groupCounts", counts: {} };
    if (op.repository?.forge === "gitlab") return { error: "forge_auth_required" };
    return prList(github, [pr(github, 9, "2026-11-04T00:00:00Z")]);
  });
  const reply = (await ask(updated)) as PullsReply;
  expect(rowsOf(reply)).toEqual(["GitHub · acme/ace #9"]);
  expect(reply.failed).toHaveLength(1);
  expect(reply.failed[0]).toMatch(/^GitLab · acme\/ace: /);
  // With a repository unread no count is known, so none undercounts.
  expect(reply.counts).toBeNull();
  expect(reply.groups.map((group) => group.count)).toEqual([null]);
});

test("a group's total is every repository's count of it, even one whose rows so far don't show it", async () => {
  const { ask } = service((op) => {
    if (op.op === "forge.repositories")
      return repositories(entry(github, { primary: true }), entry(gitlab));
    if (op.op === "forge.group-counts")
      return { resource: "groupCounts", counts: { all: op.repository ? 7 : 1 } };
    // GitLab's first page is empty though it counts seven.
    if (op.repository?.forge === "gitlab") return prList(gitlab, []);
    return prList(github, [pr(github, 9, "2026-11-04T00:00:00Z")]);
  });
  const reply = (await ask(updated)) as PullsReply;
  expect(reply.groups.map((group) => [group.id, group.count])).toEqual([["all", 8]]);
});

test("a project whose repositories can't be read says so and leaves its counts unknown", async () => {
  const { ask } = service((op) => {
    if (op.op === "forge.repositories") return { error: "forge_read_failed" };
    if (op.op === "forge.group-counts") return { resource: "groupCounts", counts: { all: 1 } };
    return prList(github, [pr(github, 9, "2026-11-04T00:00:00Z")]);
  });
  const reply = (await ask(updated)) as PullsReply;
  expect(rowsOf(reply)).toEqual(["- #9"]);
  expect(reply.failed).toEqual([
    "Couldn't read this project's repositories, so only its primary is listed.",
  ]);
  expect(reply.counts).toBeNull();
});

test("a project whose choices hide every repository lists nothing and reads no host", async () => {
  const { ask, ops } = service((op) => {
    if (op.op === "forge.repositories")
      return {
        resource: "repositories",
        value: {
          workspaceId: WorkspaceId.parse("ace"),
          repositories: [entry(github, { visible: false })],
          primary: null,
          config: { added: [], hidden: [github], primary: null },
        },
      };
    return { error: "forge_read_failed" };
  });
  const reply = (await ask(updated)) as PullsReply;
  expect(reply.groups).toEqual([]);
  expect(reply.failed).toEqual([]);
  expect(ops.map((op) => op.op)).toEqual(["forge.repositories"]);
});

test("every repository failing fails the list as one repository's failure did", async () => {
  const { ask } = service((op) => {
    if (op.op === "forge.repositories")
      return repositories(entry(github, { primary: true }), entry(gitlab));
    return { error: "forge_auth_required" };
  });
  await expect(ask(updated)).rejects.toThrow();
});

test("a project with one repository lists it without naming the repository on its rows", async () => {
  const { ask } = service((op) => {
    if (op.op === "forge.repositories") return repositories(entry(github, { primary: true }));
    if (op.op === "forge.group-counts") return { resource: "groupCounts", counts: {} };
    return prList(github, [pr(github, 9, "2026-11-04T00:00:00Z")]);
  });
  expect(rowsOf((await ask(updated)) as PullsReply)).toEqual(["- #9"]);
});

test("a daemon that can't list repositories reads the project's own, as before", async () => {
  const { ask, ops } = service((op) => {
    if (op.op === "forge.repositories") return { error: "unsupported" };
    if (op.op === "forge.group-counts") return { resource: "groupCounts", counts: {} };
    return prList(github, [pr(github, 9, "2026-11-04T00:00:00Z")]);
  });
  expect(rowsOf((await ask(updated)) as PullsReply)).toEqual(["- #9"]);
  expect(ops.find((op) => op.op === "forge.pr.list")?.repository).toBeUndefined();
});

test("Show more reads one more page of each repository that has more, and none of one that doesn't", async () => {
  const { ask, ops } = service((op) => {
    if (op.op === "forge.repositories")
      return repositories(entry(github, { primary: true }), entry(gitlab));
    if (op.op === "forge.group-counts") return { resource: "groupCounts", counts: {} };
    if (op.repository?.forge === "gitlab")
      return prList(gitlab, [pr(gitlab, 5, "2026-11-03T00:00:00Z")]);
    const page = op.query?.page ?? 1;
    return prList(
      github,
      [pr(github, 10 - page, `2026-11-0${5 - page}T00:00:00Z`)],
      page === 1 ? 2 : undefined,
    );
  });
  const first = (await ask(updated)) as PullsReply;
  expect(first.more).toBe(true);
  const second = (await ask({ ...updated, screens: 2 })) as PullsReply;
  expect(second.more).toBe(false);
  expect(rowsOf(second)).toEqual([
    "GitHub · acme/ace #9",
    "GitHub · acme/ace #8",
    "GitLab · acme/ace #5",
  ]);
  const gitlabPages = ops.filter(
    (op) => op.op === "forge.pr.list" && op.repository?.forge === "gitlab",
  );
  expect(gitlabPages.every((op) => op.query?.page === 1)).toBe(true);
});

test("issues come from every repository ace reads issues from, newest first, each naming its repository", async () => {
  const upstream: ForgeRepository = { ...github, owner: "upstream" };
  const { ask, ops } = service((op) => {
    if (op.op === "forge.repositories")
      return repositories(entry(github, { primary: true }), entry(gitlab), entry(upstream));
    if (op.op === "forge.group-counts") return { resource: "groupCounts", counts: {} };
    const repository = op.repository ?? github;
    const items =
      repository.owner === "upstream"
        ? [issue(upstream, 3, "2026-11-05T00:00:00Z")]
        : [issue(github, 4, "2026-11-02T00:00:00Z")];
    return {
      resource: "issueList",
      value: {
        repository,
        items,
        total: 1,
        counts: { open: 1, closed: 0 },
        canCreate: repository === github,
        unavailableReason: "",
        incomplete: false,
        truncated: false,
      },
    };
  });
  const reply = (await ask({ type: "forge.issues", project: "ace", search: {} })) as IssuesReply;
  expect(rowsOf(reply)).toEqual(["GitHub · upstream/ace #3", "GitHub · acme/ace #4"]);
  expect(reply.counts).toEqual({ open: 2, closed: 0 });
  expect(reply.canCreate).toBe(true);
  // A GitLab mirror lists its merge requests in Pull requests, nothing in Issues.
  const read = ops.filter((op) => op.op === "forge.issue.list");
  expect(read.some((op) => op.repository?.forge === "gitlab")).toBe(false);
});
