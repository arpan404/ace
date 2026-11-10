import { describe, expect, it } from "vitest";
import { GitLabReader } from "./gitlab-reader.ts";
import { ForgeError } from "./errors.ts";
import { ForgePrSearch } from "@ace/protocol/forge-browser";
import type { CommandRequest, CommandResult, CommandRunner } from "./command.ts";

const repository = { forge: "gitlab" as const, host: "gitlab.com", owner: "acme", name: "ace" };
const signal = () => new AbortController().signal;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function http(status: string, headers: Record<string, string>, body: unknown): string {
  const lines = [`HTTP/2.0 ${status}`];
  for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
  return `${lines.join("\r\n")}\r\n\r\n${typeof body === "string" ? body : JSON.stringify(body)}`;
}

function runner(
  routes: Record<string, { status: string; headers?: Record<string, string>; body: unknown }>,
  seen: CommandRequest[] = [],
) {
  return {
    seen,
    runner: (async (request: CommandRequest): Promise<CommandResult> => {
      seen.push(request);
      const endpoint = request.args[1] as string;
      const route =
        routes[endpoint] ??
        (endpoint.includes("/pipelines?") ? { status: "200 OK", body: [] } : undefined) ??
        (endpoint.includes("merge_requests?") ? routes["*list"] : undefined) ??
        (endpoint.includes("/diffs?") ? routes["*diffs"] : undefined) ??
        (endpoint.includes("/discussions?") || endpoint.includes("/commits?")
          ? { status: "200 OK", headers: { "x-next-page": "", "x-total": "0" }, body: [] }
          : undefined) ??
        (endpoint.endsWith("/approvals")
          ? { status: "200 OK", body: { approved_by: [], approved: false } }
          : undefined) ??
        (endpoint.endsWith("/approval_state")
          ? { status: "200 OK", body: { rules: [] } }
          : undefined) ??
        routes["*mr"];
      if (!route) return { code: 1, stdout: http("404 Not Found", {}, {}), truncated: false };
      return {
        code: 0,
        stdout: http(route.status, route.headers ?? {}, route.body),
        truncated: false,
      };
    }) as (request: CommandRequest) => Promise<CommandResult>,
  };
}

const cliFailure: (request: CommandRequest) => Promise<CommandResult> = async () => ({
  code: 1,
  stdout: "secret-token abc",
  truncated: false,
});
const cliOverflow: (request: CommandRequest) => Promise<CommandResult> = async () => ({
  code: 0,
  stdout: "x",
  truncated: true,
});
const cancellingCounts: CommandRunner = async (request: CommandRequest) => {
  if ((request.args[1] as string).includes("per_page=1")) throw new ForgeError("cancelled");
  return { code: 0, stdout: http("200 OK", { "x-total": "1" }, [mr()]), truncated: false };
};
const failingCounts: CommandRunner = async (request: CommandRequest) => {
  if ((request.args[1] as string).includes("per_page=1"))
    return { code: 1, stdout: http("409 Conflict", {}, {}), truncated: false };
  return { code: 0, stdout: http("200 OK", {}, [mr()]), truncated: false };
};
const prQuery = (over: Record<string, unknown> = {}) =>
  ForgePrSearch.parse({
    state: "open",
    ci: "any",
    search: "",
    labels: [],
    review: "any",
    sort: "updated",
    order: "desc",
    page: 1,
    ...over,
  });
const mr = (over: Record<string, unknown> = {}) => ({
  iid: 7,
  title: "Add feature",
  description: "body text",
  web_url: "https://gitlab.com/acme/ace/-/merge_requests/7",
  state: "opened",
  updated_at: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  source_branch: "feat",
  target_branch: "main",
  author: { username: "octo" },
  labels: [],
  user_notes_count: 3,
  sha: HEAD,
  diff_refs: { base_sha: BASE, head_sha: HEAD, start_sha: BASE },
  detailed_merge_status: "mergeable",
  changes_count: "1",
  ...over,
});

describe("gitlab reader", () => {
  it("reads status with pinned head sha", async () => {
    const f = runner({ "*mr": { status: "200 OK", body: mr() } });
    const reader = new GitLabReader({ repository, runner: f.runner });
    const status = await reader.status(7, signal());
    expect(status).toMatchObject({
      title: "Add feature",
      headSha: HEAD,
      state: "open",
      ci: "none",
    });
    expect(f.seen[0]?.args).toEqual([
      "api",
      "projects/acme%2Face/merge_requests/7",
      "-X",
      "GET",
      "--hostname",
      "gitlab.com",
      "--include",
    ]);
  });

  it("maps draft and merged states", async () => {
    const f = runner({ "*mr": { status: "200 OK", body: mr({ state: "opened", draft: true }) } });
    const reader = new GitLabReader({ repository, runner: f.runner });
    expect((await reader.status(7, signal())).state).toBe("draft");
  });

  it("builds canonical URLs, never trusting the server web_url", async () => {
    const hostile = mr({ web_url: "https://evil.example/x?token=abc" });
    const f = runner({ "*mr": { status: "200 OK", body: hostile } });
    const status = await new GitLabReader({ repository, runner: f.runner }).status(7, signal());
    expect(status.url).toBe("https://gitlab.com/acme/ace/-/merge_requests/7");
  });

  it("rejects missing heads instead of fabricating SHAs", async () => {
    const headless = mr({ sha: undefined, diff_refs: undefined });
    const f = runner({ "*mr": { status: "200 OK", body: headless } });
    const reader = new GitLabReader({ repository, runner: f.runner });
    await expect(reader.status(7, signal())).rejects.toMatchObject({ kind: "invalid_data" });
    await expect(reader.prDetail(7, signal())).rejects.toMatchObject({ kind: "invalid_data" });
    await expect(reader.prCheckout(7, signal())).rejects.toMatchObject({ kind: "invalid_data" });
    const list = runner({
      "*list": { status: "200 OK", headers: { "x-total": "1" }, body: [headless] },
    });
    await expect(
      new GitLabReader({ repository, runner: list.runner }).listPrs(
        prQuery({ state: "all" }),
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "invalid_data" });
  });

  it("aggregates patch truncation into the page", async () => {
    const f = runner({
      "*mr": { status: "200 OK", body: mr() },
      "*diffs": {
        status: "200 OK",
        body: [
          { old_path: "a.ts", new_path: "a.ts", diff: `@@ -0,0 +1 @@\n+${"x".repeat(300_000)}` },
        ],
      },
    });
    const files = await new GitLabReader({ repository, runner: f.runner }).prFiles(
      { number: 7, page: 1, headSha: HEAD, baseSha: BASE },
      signal(),
    );
    expect(files.files[0]?.truncated).toBe(true);
    expect(files.truncated).toBe(true);
  });

  it("never projects a future state as open, and drops it from lists as incomplete", async () => {
    const f = runner({ "*mr": { status: "200 OK", body: mr({ state: "locked" }) } });
    const reader = new GitLabReader({ repository, runner: f.runner });
    expect((await reader.status(7, signal())).state).toBe("unknown");
    const list = runner({
      "*list": {
        status: "200 OK",
        headers: { "x-total": "2" },
        body: [mr({ state: "locked" }), mr({ iid: 8, title: "Readable" })],
      },
    });
    const page = await new GitLabReader({ repository, runner: list.runner }).listPrs(
      prQuery({ state: "all" }),
      signal(),
    );
    expect(page.items.map((item) => item.ref.number)).toEqual([8]);
    expect(page.incomplete).toBe(true);
  });

  it("keeps a record whose title or labels exceed protocol bounds, cut to fit", async () => {
    const labels = Array.from({ length: 150 }, (_, index) => `label-${index}`);
    const f = runner({
      "*mr": { status: "200 OK", body: mr({ title: "t".repeat(70_000), labels }) },
    });
    const detail = await new GitLabReader({ repository, runner: f.runner }).prDetail(7, signal());
    expect(detail.status.title).toHaveLength(65_536);
    expect(detail.labels).toHaveLength(100);
  });

  it("lists all states with an explicit state=all", async () => {
    const seen: CommandRequest[] = [];
    const rows = [
      mr(),
      mr({ iid: 8, title: "Old", state: "closed" }),
      mr({ iid: 9, title: "Done", state: "merged" }),
    ];
    const f = runner(
      {
        "projects/acme%2Face/merge_requests?per_page=25&page=1&order_by=updated_at&sort=desc&state=all":
          {
            status: "200 OK",
            headers: { "x-total": "3", "x-next-page": "" },
            body: rows,
          },
        "*list": { status: "200 OK", headers: { "x-total": "0" }, body: [] },
      },
      seen,
    );
    const page = await new GitLabReader({ repository, runner: f.runner }).listPrs(
      prQuery({ state: "all" }),
      signal(),
    );
    expect(seen[0]?.args[1]).toContain("state=all");
    expect(page.items.map((item) => item.state)).toEqual(["open", "closed", "merged"]);
    expect(page.total).toBe(3);
    expect(page.nextPage).toBeUndefined();
  });

  it("uses the filtered page total for text search", async () => {
    const seen: CommandRequest[] = [];
    const f = runner(
      {
        "projects/acme%2Face/merge_requests?per_page=25&page=1&order_by=updated_at&sort=desc&search=feat&state=opened&wip=no":
          {
            status: "200 OK",
            headers: { "x-total": "5" },
            body: [mr()],
          },
        "*list": { status: "200 OK", headers: { "x-total": "0" }, body: [] },
      },
      seen,
    );
    const page = await new GitLabReader({ repository, runner: f.runner }).listPrs(
      prQuery({ search: "feat" }),
      signal(),
    );
    expect(page.total).toBe(5);
    expect(page.incomplete).toBe(false);
    const countUrls = seen.slice(1).map((request) => request.args[1] as string);
    expect(countUrls).toHaveLength(4);
    for (const url of countUrls) expect(url).toContain("search=feat");
  });

  it("flags incomplete when count headers are unavailable, keeping row lower bounds", async () => {
    const f = runner({
      "projects/acme%2Face/merge_requests?per_page=25&page=1&order_by=updated_at&sort=desc&state=opened&wip=no":
        {
          status: "200 OK",
          headers: {},
          body: [mr(), mr({ iid: 8, title: "Second" })],
        },
      "*list": { status: "200 OK", headers: {}, body: [] },
    });
    const page = await new GitLabReader({ repository, runner: f.runner }).listPrs(
      prQuery(),
      signal(),
    );
    expect(page.total).toBe(2);
    expect(page.incomplete).toBe(true);
  });

  it("propagates cancellation from count reads", async () => {
    await expect(
      new GitLabReader({ repository, runner: cancellingCounts }).listPrs(prQuery(), signal()),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("never reports false zeros when counts fail", async () => {
    const page = await new GitLabReader({ repository, runner: failingCounts }).listPrs(
      prQuery(),
      signal(),
    );
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.incomplete).toBe(true);
  });

  it("lists one page and derives counts without pretending", async () => {
    const seen: CommandRequest[] = [];
    const list = [mr(), mr({ iid: 8, title: "Second" })];
    const f = runner(
      {
        "projects/acme%2Face/merge_requests?per_page=25&page=1&order_by=updated_at&sort=desc&state=opened&wip=no":
          {
            status: "200 OK",
            headers: { "x-total": "2" },
            body: list,
          },
        "*list": { status: "200 OK", headers: { "x-total": "0" }, body: [] },
        "projects/acme%2Face/merge_requests?per_page=1&page=1&state=opened&wip=no": {
          status: "200 OK",
          headers: { "x-total": "2" },
          body: [],
        },
        "projects/acme%2Face/merge_requests?per_page=1&page=1&state=closed": {
          status: "200 OK",
          headers: { "x-total": "1" },
          body: [],
        },
        "projects/acme%2Face/merge_requests?per_page=1&page=1&state=merged": {
          status: "200 OK",
          headers: { "x-total": "4" },
          body: [],
        },
        "projects/acme%2Face/merge_requests?per_page=1&page=1&state=opened&wip=yes": {
          status: "200 OK",
          headers: { "x-total": "0" },
          body: [],
        },
      },
      seen,
    );
    const reader = new GitLabReader({ repository, runner: f.runner });
    const page = await reader.listPrs(prQuery(), signal());
    expect(page.items).toHaveLength(2);
    expect(page.counts).toMatchObject({ open: 2, closed: 1, merged: 4 });
    expect(page.total).toBe(2);
    expect(page.truncated).toBe(false);
  });

  it("rejects unsupported filters instead of ignoring them", async () => {
    const f = runner({});
    const reader = new GitLabReader({ repository, runner: f.runner });
    await expect(reader.listPrs(prQuery({ ci: "failure" }), signal())).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(reader.listPrs(prQuery({ labels: ["a"] }), signal())).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(reader.listPrs(prQuery({ review: "approved" }), signal())).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(reader.listPrs(prQuery({ sort: "comments" }), signal())).rejects.toMatchObject({
      kind: "unsupported",
    });
    expect(f.seen).toHaveLength(0);
  });

  it("exposes conversation resources while checks remain unavailable", async () => {
    const f = runner({ "*mr": { status: "200 OK", body: mr() } });
    const reader = new GitLabReader({ repository, runner: f.runner });
    const detail = await reader.prDetail(7, signal());
    expect(detail.readOnly).toBe(false);
    expect(detail.unavailableResources).toEqual([]);
    expect(detail.baseSha).toBe(BASE);
  });

  it("reports GitLab's changed-file count, reading it from the diffs when not yet counted", async () => {
    const counted = runner({ "*mr": { status: "200 OK", body: mr({ changes_count: "1000+" }) } });
    expect(
      (await new GitLabReader({ repository, runner: counted.runner }).prDetail(7, signal()))
        .changedFiles,
    ).toBe(1000);
    const uncounted = runner({
      "*mr": { status: "200 OK", body: mr({ changes_count: null }) },
      "*diffs": { status: "200 OK", headers: { "x-total": "12" }, body: [] },
    });
    expect(
      (await new GitLabReader({ repository, runner: uncounted.runner }).prDetail(7, signal()))
        .changedFiles,
    ).toBe(12);
  });

  it("keeps the detail when GitLab gives no file count, naming the count unavailable", async () => {
    for (const headers of [{}, { "x-total": "" }, { "x-total": "many" }]) {
      const f = runner({
        "*mr": { status: "200 OK", body: mr({ changes_count: null }) },
        "*diffs": { status: "200 OK", headers, body: [] },
      });
      const detail = await new GitLabReader({ repository, runner: f.runner }).prDetail(7, signal());
      expect(detail.body).toBe("body text");
      expect(detail.unavailableResources).toContain("fileCount");
      expect(detail.unavailableResources).not.toContain("files");
    }
  });

  it("nulls fork head repositories instead of inventing same-repo ones", async () => {
    const same = runner({
      "*mr": {
        status: "200 OK",
        body: mr({ source_project_id: 1, target_project_id: 1, project_id: 1 }),
      },
    });
    expect(
      (await new GitLabReader({ repository, runner: same.runner }).prDetail(7, signal()))
        .headRepository,
    ).toEqual(repository);
    const fork = runner({
      "*mr": {
        status: "200 OK",
        body: mr({ source_project_id: 99, target_project_id: 1, project_id: 1 }),
      },
    });
    expect(
      (await new GitLabReader({ repository, runner: fork.runner }).prDetail(7, signal()))
        .headRepository,
    ).toBeNull();
  });

  it("pages files pinned to head/base and rejects moves", async () => {
    const seen: CommandRequest[] = [];
    const f = runner(
      {
        "*mr": { status: "200 OK", body: mr() },
        "*diffs": {
          status: "200 OK",
          headers: { "x-total": "30", "x-next-page": "3" },
          body: [
            {
              old_path: "a.ts",
              new_path: "a.ts",
              diff: "@@ -1,2 +1,2 @@\n--- x\n+++ y\n context\n",
            },
          ],
        },
      },
      seen,
    );
    const reader = new GitLabReader({ repository, runner: f.runner });
    const files = await reader.prFiles(
      { number: 7, page: 2, headSha: HEAD, baseSha: BASE },
      signal(),
    );
    // Content lines that look like file headers still count.
    expect(files.files[0]).toMatchObject({ path: "a.ts", additions: 1, deletions: 1 });
    expect(files.nextPage).toBe(3);
    expect(seen.map((request) => request.args[1])).toContain(
      "projects/acme%2Face/merge_requests/7/diffs?per_page=25&page=2",
    );
    await expect(
      reader.prFiles({ number: 7, page: 1, headSha: "c".repeat(40), baseSha: BASE }, signal()),
    ).rejects.toMatchObject({ kind: "head_moved" });
  });

  it("checks out pinned head and base", async () => {
    const f = runner({
      "*mr": {
        status: "200 OK",
        body: mr({ source_project_id: 1, target_project_id: 1, project_id: 1 }),
      },
    });
    const reader = new GitLabReader({ repository, runner: f.runner });
    const checkout = await reader.prCheckout(7, signal());
    expect(checkout).toMatchObject({
      headSha: HEAD,
      baseSha: BASE,
      headBranch: "feat",
      baseBranch: "main",
    });
    expect(checkout.headRepository).toEqual(repository);
  });

  it("resolves fork source projects for checkout, rejecting what it cannot", async () => {
    const f = runner({
      "*mr": {
        status: "200 OK",
        body: mr({ source_project_id: 99, target_project_id: 1, project_id: 1 }),
      },
      "projects/99": { status: "200 OK", body: { path_with_namespace: "someone/ace-fork" } },
    });
    const checkout = await new GitLabReader({ repository, runner: f.runner }).prCheckout(
      7,
      signal(),
    );
    expect(checkout.headRepository).toEqual({
      forge: "gitlab",
      host: "gitlab.com",
      owner: "someone",
      name: "ace-fork",
    });
    const unresolvable = runner({
      "*mr": {
        status: "200 OK",
        body: mr({ source_project_id: 99, target_project_id: 1, project_id: 1 }),
      },
      "projects/99": { status: "200 OK", body: {} },
    });
    await expect(
      new GitLabReader({ repository, runner: unresolvable.runner }).prCheckout(7, signal()),
    ).rejects.toMatchObject({ kind: "unsupported" });
    const missing = runner({ "*mr": { status: "200 OK", body: mr() } });
    await expect(
      new GitLabReader({ repository, runner: missing.runner }).prCheckout(7, signal()),
    ).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("marks a capped change count truncated, never complete", async () => {
    const f = runner({
      "*mr": { status: "200 OK", body: mr({ changes_count: "1000+" }) },
      "*diffs": { status: "200 OK", body: [] },
    });
    const files = await new GitLabReader({ repository, runner: f.runner }).prFiles(
      { number: 7, page: 1, headSha: HEAD, baseSha: BASE },
      signal(),
    );
    expect(files.truncated).toBe(true);
  });

  it("reads a withheld diff as an unread patch, not an empty change", async () => {
    const f = runner({
      "*mr": { status: "200 OK", body: mr() },
      "*diffs": {
        status: "200 OK",
        body: [{ old_path: "big.bin", new_path: "big.bin", diff: "", too_large: true }],
      },
    });
    const files = await new GitLabReader({ repository, runner: f.runner }).prFiles(
      { number: 7, page: 1, headSha: HEAD, baseSha: BASE },
      signal(),
    );
    expect(files.files[0]).toMatchObject({ patch: null, truncated: true });
    expect(files.truncated).toBe(true);
  });

  it("fails snapshots over the 8 MiB read budget", async () => {
    const f = runner({
      "*mr": { status: "200 OK", body: mr() },
      "*diffs": {
        status: "200 OK",
        body: [{ old_path: "a.ts", new_path: "a.ts", diff: `+${"x".repeat(9_000_000)}` }],
      },
    });
    await expect(
      new GitLabReader({ repository, runner: f.runner }).prFiles(
        { number: 7, page: 1, headSha: HEAD, baseSha: BASE },
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "limit" });
  });

  it("sanitizes CLI failures without leaking output", async () => {
    const reader = new GitLabReader({ repository, runner: cliFailure });
    const failure = await reader.status(7, signal()).catch((error) => error);
    expect(failure).toBeInstanceOf(ForgeError);
    expect(String(failure?.message)).not.toContain("secret-token");
    await expect(
      new GitLabReader({ repository, runner: cliOverflow }).status(7, signal()),
    ).rejects.toMatchObject({ kind: "limit" });
    const missing = runner({});
    await expect(
      new GitLabReader({ repository, runner: missing.runner }).status(99, signal()),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});
