import { expect, test } from "vitest";
import { ForgePrSearch } from "@ace/protocol/forge-browser";
import { ForgeIssueSearch } from "@ace/protocol/forge-issues";
import { TeaReader } from "./tea-reader.ts";
import type { CommandRunner } from "./command.ts";
const head = "a".repeat(40),
  base = "b".repeat(40);
const signal = new AbortController().signal;
// Handmade API v1 examples from https://gitea.com/swagger.v1.json.
const pull = {
  number: 7,
  title: "New feature",
  state: "open",
  merged: false,
  head: { sha: head, ref: "feature", repo: { name: "fork", owner: { login: "alice" } } },
  base: { sha: base, ref: "main" },
  user: { login: "alice" },
  changed_files: 1,
  body: "Description",
  future_field: { hello: true },
};
const issue = {
  number: 3,
  title: "Bug",
  state: "open",
  user: { login: "bob" },
  created_at: "2026-01-01",
  updated_at: "2026-01-02",
  body: "Reproduce",
  labels: [{ name: "bug" }],
};
function reader(forge: "gitea" | "forgejo", respond: (path: string) => unknown, total = 1) {
  const runner: CommandRunner = async (r) => {
    if (r.command !== "tea" || r.args.slice(2).join(" ") !== "--method GET --login work --include")
      throw new Error("unsafe read");
    return {
      code: 0,
      stdout: JSON.stringify(respond(r.args[1] ?? "")),
      truncated: false,
      http: { status: 200, headers: { "x-total-count": String(total) } },
    };
  };
  return new TeaReader({
    repository: { forge, host: "git.example", owner: "team", name: "app" },
    login: "work",
    runner,
  });
}
for (const forge of ["gitea", "forgejo"] as const) {
  test(`${forge} reads PR detail, canonical links, unknown fields and fork checkout`, async () => {
    const r = reader(forge, () => ({ ...pull, html_url: "https://evil.test?token=secret" }));
    expect(await r.status(7, signal)).toMatchObject({
      state: "open",
      headSha: head,
      url: "https://git.example/team/app/pulls/7",
      raw: { future_field: { hello: true } },
    });
    expect(await r.prDetail(7, signal)).toMatchObject({
      body: "Description",
      baseSha: base,
      readOnly: true,
      unavailableResources: ["comments", "checks", "reviews", "commits"],
    });
    expect(await r.prCheckout(7, signal)).toMatchObject({
      headSha: head,
      baseSha: base,
      headRepository: { forge, owner: "alice", name: "fork" },
    });
  });
  test(`${forge} lists drafts separately and refuses unsupported filtering`, async () => {
    const r = reader(
      forge,
      () => [
        pull,
        { ...pull, number: 8, title: "WIP: next" },
        { ...pull, number: 9, state: "future" },
      ],
      3,
    );
    expect(await r.listPrs(ForgePrSearch.parse({ state: "open" }), signal)).toMatchObject({
      items: [{ ref: { number: 7 } }],
      incomplete: true,
    });
    expect(
      (await r.listPrs(ForgePrSearch.parse({ state: "draft" }), signal)).items.map(
        (p) => p.ref.number,
      ),
    ).toEqual([8]);
    await expect(r.listPrs(ForgePrSearch.parse({ author: "alice" }), signal)).rejects.toMatchObject(
      { kind: "unsupported" },
    );
  });
  test(`${forge} pins files before and after the read and marks missing patches`, async () => {
    let reads = 0;
    let moved = false;
    const r = reader(forge, (p) =>
      p.includes("/files?")
        ? [
            {
              filename: "new.ts",
              previous_filename: "old.ts",
              status: "renamed",
              additions: 2,
              deletions: 1,
            },
          ]
        : { ...pull, base: { ...pull.base, sha: moved && ++reads > 1 ? "c".repeat(40) : base } },
    );
    expect(
      await r.prFiles({ number: 7, page: 1, headSha: head, baseSha: base }, signal),
    ).toMatchObject({
      files: [{ path: "new.ts", previousPath: "old.ts", patch: null, truncated: true }],
    });
    moved = true;
    await expect(
      r.prFiles({ number: 7, page: 1, headSha: head, baseSha: base }, signal),
    ).rejects.toMatchObject({ kind: "head_moved" });
  });
  test(`${forge} reads commits at the pinned head and rejects stale cursors`, async () => {
    const r = reader(forge, (p) =>
      p.includes("/commits?")
        ? [
            {
              sha: head,
              commit: {
                message: "Implement feature",
                author: { name: "Alice", date: "2026-01-01" },
              },
            },
          ]
        : pull,
    );
    expect(await r.prCommits(7, undefined, head, signal)).toMatchObject({
      commits: [{ sha: head, message: "Implement feature", author: "Alice" }],
      total: 1,
      truncated: false,
    });
    await expect(r.prCommits(7, undefined, base, signal)).rejects.toMatchObject({
      kind: "head_moved",
    });
    await expect(r.prCommits(7, "other", head, signal)).rejects.toMatchObject({
      kind: "invalid_data",
    });
  });
  test(`${forge} reads issues and preserves new timeline event types`, async () => {
    const r = reader(forge, (p) =>
      p.includes("/timeline?")
        ? [{ id: 10, type: "future_activity", user: { login: "bob" }, extra: true }]
        : p.includes("issues?")
          ? [issue]
          : issue,
    );
    expect(await r.issues.listIssues(ForgeIssueSearch.parse({}), signal)).toMatchObject({
      items: [{ ref: { number: 3 }, labels: ["bug"] }],
      canCreate: false,
    });
    expect(await r.issues.issueDetail(3, signal)).toMatchObject({
      body: "Reproduce",
      permissions: { comment: false },
    });
    expect(await r.issues.issueTimeline(3, 1, signal)).toMatchObject({
      events: [{ event: "future_activity", kind: "activity", raw: { extra: true } }],
    });
  });
}
test("malformed API data, wrong issue numbers, missing fork sources and PRs in issues fail closed", async () => {
  await expect(
    reader("gitea", () => ({ ...pull, number: 9 })).status(7, signal),
  ).rejects.toMatchObject({ kind: "invalid_data" });
  await expect(
    reader("gitea", () => ({ ...pull, head: { ...pull.head, repo: null } })).prCheckout(7, signal),
  ).rejects.toMatchObject({ kind: "unsupported" });
  await expect(
    reader("gitea", () => ({ ...issue, pull_request: {} })).issues.issueDetail(3, signal),
  ).rejects.toMatchObject({ kind: "invalid_data" });
});

test("commit pages expose the newest commit first", async () => {
  const r = reader(
    "forgejo",
    (path) =>
      path.includes("/commits?")
        ? [
            { sha: base, commit: { message: "Older", author: { name: "Alice" } } },
            { sha: head, commit: { message: "Newer", author: { name: "Alice" } } },
          ]
        : pull,
    2,
  );
  expect((await r.prCommits(7, undefined, head, signal)).commits.map((c) => c.message)).toEqual([
    "Newer",
    "Older",
  ]);
});
