import { expect, test } from "vitest";
import { ForgePrSearch } from "@ace/protocol/forge-browser";
import { ForgeIssueSearch } from "@ace/protocol/forge-issues";
import { ForgeListCaches, GitHubForge } from "./index.ts";
import { fakeGh, issueRecord, repository, type Fixtures } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const open = ForgePrSearch.parse({ state: "active" });
const prSearch = `search/issues?${new URLSearchParams({
  q: "repo:octo/ace is:pr is:open",
  sort: "updated",
  order: "desc",
  per_page: "25",
  page: "1",
})}`;
const issueSearch = `search/issues?${new URLSearchParams({
  q: "repo:octo/ace is:issue is:open",
  sort: "updated",
  order: "desc",
  per_page: "25",
  page: "1",
})}`;
const counts = {
  data: {
    open: { issueCount: 1 },
    draft: { issueCount: 0 },
    closed: { issueCount: 0 },
    merged: { issueCount: 0 },
  },
};
const row = (title: string) => ({
  number: 7,
  title,
  html_url: "https://github.com/octo/ace/pull/7",
  user: { login: "octo" },
  state: "open",
  draft: false,
  labels: [],
  updated_at: "2026-10-01T00:00:00Z",
  pull_request: { merged_at: null },
});
const prList = (title: string, barrier?: string): Fixtures => ({
  [prSearch]: [
    {
      body: { total_count: 1, incomplete_results: false, items: [row(title)] },
      ...(barrier ? { barrier } : {}),
    },
  ],
  graphql: [{ body: counts }],
});
const searches = async (gh: { requests(): Promise<{ path: string }[]> }) =>
  (await gh.requests()).filter((request) => request.path.startsWith("search/")).length;

test("opening the PR list again within a minute reuses the last answer, and asks GitHub after", async () => {
  let now = 1_000;
  const gh = await fakeGh(prList("First"), { now: () => now });
  try {
    expect((await gh.forge.listPrs(open, signal())).items[0]?.title).toBe("First");
    await gh.replace(prList("Second"));
    now += 59_000;
    expect((await gh.forge.listPrs(open, signal())).items[0]?.title).toBe("First");
    expect(await searches(gh)).toBe(1);
    now += 1_000;
    expect((await gh.forge.listPrs(open, signal())).items[0]?.title).toBe("Second");
    expect(await searches(gh)).toBe(2);
  } finally {
    await gh.cleanup();
  }
});

test("a different search is its own list and still asks GitHub", async () => {
  const failing = `search/issues?${new URLSearchParams({
    q: "repo:octo/ace is:pr is:open status:failure",
    sort: "updated",
    order: "desc",
    per_page: "25",
    page: "1",
  })}`;
  const fixtures = prList("Open");
  fixtures[failing] = [
    { body: { total_count: 1, incomplete_results: false, items: [row("Failing")] } },
  ];
  const gh = await fakeGh(fixtures);
  try {
    await gh.forge.listPrs(open, signal());
    const result = await gh.forge.listPrs(
      ForgePrSearch.parse({ state: "active", ci: "failure" }),
      signal(),
    );
    expect(result.items[0]?.title).toBe("Failing");
  } finally {
    await gh.cleanup();
  }
});

test("windows opening the same list at once share one GitHub request", async () => {
  const gh = await fakeGh(prList("Shared", "go"));
  try {
    const first = gh.forge.listPrs(open, signal());
    const second = gh.forge.listPrs(open, signal());
    await gh.waitForRequest(prSearch);
    await gh.release("go");
    const [a, b] = await Promise.all([first, second]);
    expect([a.items[0]?.title, b.items[0]?.title]).toEqual(["Shared", "Shared"]);
    expect(await searches(gh)).toBe(1);
  } finally {
    await gh.cleanup();
  }
});

test("one window leaving does not cancel the list another is still waiting for", async () => {
  const gh = await fakeGh(prList("Kept", "go"));
  try {
    const leaving = new AbortController();
    const left = gh.forge.listPrs(open, leaving.signal);
    const staying = gh.forge.listPrs(open, signal());
    await gh.waitForRequest(prSearch);
    leaving.abort();
    await expect(left).rejects.toThrow();
    await gh.release("go");
    expect((await staying).items[0]?.title).toBe("Kept");
  } finally {
    await gh.cleanup();
  }
});

const issues = (title: string): Fixtures => ({
  [issueSearch]: [
    { body: { total_count: 1, incomplete_results: false, items: [{ ...issueRecord, title }] } },
  ],
  graphql: [{ body: { data: { open: { issueCount: 1 }, closed: { issueCount: 0 } } } }],
  "repos/octo/ace": [{ body: { archived: false, has_issues: true } }],
  "repos/octo/ace/issues": [{ status: 201, body: issueRecord }],
});

test("a write from another checkout of the repository makes the next list read ask GitHub", async () => {
  const lists = new ForgeListCaches(() => 1_000);
  const gh = await fakeGh(issues("Before"));
  const backend = () =>
    new GitHubForge({
      repository,
      runner: gh.runner,
      command: gh.executable,
      now: () => 1_000,
      lists,
    });
  const root = backend();
  const worktree = backend();
  const all = ForgeIssueSearch.parse({});
  try {
    expect((await root.listIssues(all, signal())).items[0]?.title).toBe("Before");
    await gh.replace(issues("After"));
    expect((await worktree.listIssues(all, signal())).items[0]?.title).toBe("Before");
    await worktree.writeIssue({ action: "create", title: "New", body: "" }, "create", signal());
    expect((await root.listIssues(all, signal())).items[0]?.title).toBe("After");
  } finally {
    await gh.cleanup();
  }
});
