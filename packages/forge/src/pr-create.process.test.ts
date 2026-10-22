import { afterEach, expect, test } from "vitest";
import { GitHubForge } from "./index.ts";
import { fakeGh, pr, sha, type Fixtures } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const cleanups: (() => Promise<void>)[] = [];
async function setup(fixtures: Fixtures) {
  const gh = await fakeGh(fixtures);
  cleanups.push(gh.cleanup);
  return gh;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const input = {
  branch: "work/card",
  base: "main",
  title: "Card",
  summary: "Adds the card",
  template: { title: "{{title}}", body: "{{summary}}" },
  draft: false,
};
const lookup = (owner: string, repo = "octo/ace") =>
  `repos/${repo}/pulls?${new URLSearchParams({ state: "open", head: `${owner}:work/card`, base: "main", per_page: "10" })}`;
const created = (number: number) => ({ ...pr, number, head: { sha, ref: "work/card" } });

test("Create PR after a merged PR opens a new one", async () => {
  // GitHub lists the branch's earlier, merged PR only under state=all; it is history.
  const everyState = `repos/octo/ace/pulls?${new URLSearchParams({ state: "all", head: "octo:work/card", base: "main", per_page: "2" })}`;
  const merged = { ...created(7), state: "closed", merged: true, base: { ref: "main" } };
  const gh = await setup({
    [everyState]: [{ body: [merged] }],
    [lookup("octo")]: [{ body: [] }],
    "repos/octo/ace/pulls": [{ status: 201, body: created(12) }],
  });
  expect(await gh.forge.findPr("work/card", "main", signal())).toBeNull();
  expect(await gh.forge.createPr("thread", input, signal())).toMatchObject({ number: 12 });
  const requests = await gh.requests();
  expect(requests.find((request) => request.path === "repos/octo/ace/pulls")?.body).toMatchObject({
    head: "work/card",
    base: "main",
    title: "Card",
  });
});

test("a fork PR targets upstream with the fork's owner on the head", async () => {
  const upstream = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
  const gh = await setup({
    [lookup("octo", "acme/ace")]: [{ body: [] }],
    "repos/acme/ace/pulls": [{ status: 201, body: created(40) }],
  });
  const forge = new GitHubForge({
    repository: upstream,
    runner: gh.runner,
    command: gh.executable,
    now: () => 1_000,
  });
  expect(await forge.findPr("work/card", "main", signal(), { owner: "octo", name: "ace" })).toBeNull();
  expect(await forge.createPr("thread", input, signal(), { owner: "octo", name: "ace" })).toEqual({
    repository: upstream,
    number: 40,
  });
  const post = (await gh.requests()).find((request) => request.path === "repos/acme/ace/pulls");
  expect(post?.body).toMatchObject({ head: "octo:work/card", base: "main" });
});

test("the repository's default branch and fork parent come from the host", async () => {
  const gh = await setup({
    "repos/octo/ace": [
      {
        body: {
          name: "ace",
          owner: { login: "octo" },
          default_branch: "trunk",
          fork: true,
          parent: { name: "ace", owner: { login: "acme" }, default_branch: "master" },
        },
      },
    ],
  });
  expect(await gh.forge.repositoryMetadata(signal())).toEqual({
    repository: { forge: "github", host: "github.com", owner: "octo", name: "ace" },
    defaultBranch: "trunk",
    parent: {
      repository: { forge: "github", host: "github.com", owner: "acme", name: "ace" },
      defaultBranch: "master",
    },
  });
});

for (const [message, errors, kind] of [
  [
    "Validation Failed",
    [{ resource: "PullRequest", code: "custom", message: "No commits between main and work/card" }],
    "no_commits",
  ],
  [
    "Validation Failed",
    [
      {
        resource: "PullRequest",
        code: "custom",
        message: "A pull request already exists for octo:work/card.",
      },
    ],
    "pr_exists",
  ],
  [
    "Validation Failed",
    [{ resource: "PullRequest", field: "head", code: "invalid" }],
    "head_missing",
  ],
  [
    "Validation Failed",
    [{ resource: "PullRequest", field: "base", code: "invalid" }],
    "base_missing",
  ],
  [
    "Validation Failed",
    [{ resource: "PullRequest", field: "title", code: "missing_field" }],
    "unprocessable",
  ],
] as const)
  test(`a 422 create refusal (${kind}) has its own code and is definitely not dispatched`, async () => {
    const gh = await setup({
      "repos/octo/ace/pulls": [{ status: 422, body: { message, errors } }],
    });
    await expect(gh.forge.createPr("thread", input, signal())).rejects.toMatchObject({
      kind,
      dispatched: false,
    });
  });

test("a PR written by hand keeps its text exactly, placeholders included", async () => {
  const gh = await setup({ "repos/octo/ace/pulls": [{ status: 201, body: created(13) }] });
  expect(
    await gh.forge.openPr(
      { branch: "work/card", base: "main", title: "Card {{x}}", body: "Body {{y}}", draft: true },
      signal(),
    ),
  ).toMatchObject({ number: 13 });
  const post = (await gh.requests()).find((request) => request.path === "repos/octo/ace/pulls");
  expect(post?.body).toEqual({
    head: "work/card",
    base: "main",
    title: "Card {{x}}",
    body: "Body {{y}}",
    draft: true,
  });
});

test("a fork with its parent's owner opens from its own branch, named with head_repo", async () => {
  const gh = await setup({
    // GitHub's owner:branch filter matches the parent's branch of the same name too.
    [lookup("octo")]: [
      {
        body: [
          { ...created(5), base: { ref: "main" }, head: { sha, ref: "work/card", repo: { name: "ace", owner: { login: "octo" } } } },
        ],
      },
    ],
    "repos/octo/ace/pulls": [{ status: 201, body: created(6) }],
  });
  const fork = { owner: "octo", name: "ace-fork" };
  // The parent's own PR from work/card isn't the fork's.
  expect(await gh.forge.findPr("work/card", "main", signal(), fork)).toBeNull();
  expect(await gh.forge.createPr("thread", input, signal(), fork)).toMatchObject({ number: 6 });
  const post = (await gh.requests()).find((request) => request.path === "repos/octo/ace/pulls");
  expect(post?.body).toMatchObject({ head: "octo:work/card", head_repo: "ace-fork" });
});

test("the fork's own open PR is found among same-named branches of its network", async () => {
  const repo = (name: string) => ({ name, owner: { login: "octo" } });
  const gh = await setup({
    [lookup("octo")]: [
      {
        body: [
          { ...created(5), base: { ref: "main" }, head: { sha, ref: "work/card", repo: repo("ace") } },
          { ...created(8), base: { ref: "main" }, head: { sha, ref: "work/card", repo: repo("ace-fork") } },
        ],
      },
    ],
  });
  expect(
    await gh.forge.findPr("work/card", "main", signal(), { owner: "octo", name: "ace-fork" }),
  ).toMatchObject({ number: 8 });
});
