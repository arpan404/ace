import { describe, expect, it } from "vitest";
import { OriginListSnapshots } from "./origin-list-snapshots.ts";
import { OriginReader } from "./origin-reader.ts";
import { ForgeError } from "./errors.ts";
import type { CommandRequest, CommandResult } from "./command.ts";
import type { ForgePrSearch } from "@ace/protocol/forge-browser";

const repository = {
  forge: "origin" as const,
  host: "origin.cursor.com",
  owner: "acme",
  name: "rocket",
};
const signal = () => new AbortController().signal;
const HEAD = "9a41f0c3d2b8e7f6a5c4d3e2f1b0a9c8d7e6f5a4";
const BASE = "3b1f9c2d8a7e6f5049c8b7a6d5e4f3a2b1c0d9e8";

const pr = (over: Record<string, unknown> = {}) => ({
  id: "pr_01k2ja2000e0080000000000d4",
  number: "17",
  state: "open",
  draft: false,
  merged: false,
  title: "Add launch telemetry",
  body: "Adds structured launch telemetry to the ignition path.",
  head: { ref: "add-telemetry", sha: HEAD },
  base: { ref: "main", sha: BASE },
  author: {
    user: { id: "user_01k2ja2000e0080000000000c3", email: "jane@acme.dev", handle: "jane" },
  },
  createdAt: "2026-08-01T09:30:00Z",
  updatedAt: "2026-08-02T14:45:00Z",
  additions: 128,
  deletions: 46,
  changedFiles: 5,
  labels: [{ id: "lbl_01k2ja2000e0080000000000m1", name: "bug", color: "d73a4a" }],
  webUrl: "https://cursor.com/codebase/acme/rocket/pull/17",
  version: { number: "3", headSha: HEAD, baseSha: BASE, createdAt: "2026-08-01T09:30:00Z" },
  ...over,
});

type Route = { code?: number; body: unknown; truncated?: boolean; unreachable?: boolean };

function runner(routes: Record<string, Route>, seen: CommandRequest[] = []) {
  return {
    seen,
    runner: (async (request: CommandRequest): Promise<CommandResult> => {
      seen.push(request);
      const endpoint = request.args[1] as string;
      const route = routes[endpoint] ?? routes["*"];
      if (!route)
        return {
          code: 1,
          stdout: JSON.stringify({ code: 5, message: "resource not found" }),
          truncated: false,
        };
      return {
        code: route.code ?? 0,
        stdout: typeof route.body === "string" ? route.body : JSON.stringify(route.body),
        truncated: route.truncated ?? false,
        ...(route.unreachable ? { unreachable: true as const } : {}),
      };
    }) as (request: CommandRequest) => Promise<CommandResult>,
  };
}

const listEndpoint = (extra = "") =>
  `/repos/acme/rocket/pulls?state=all&sortBy=updated&direction=desc&pageSize=100${extra}`;
const detailEndpoint = "/repos/acme/rocket/pulls/17";
const filesEndpoint = (extra = "") => `/repos/acme/rocket/pulls/17/files?pageSize=100${extra}`;
const search: ForgePrSearch = {
  state: "open",
  ci: "any",
  search: "",
  author: "",
  reviewer: "",
  assignee: "",
  labels: [],
  review: "any",
  sort: "updated",
  order: "desc",
  page: 1,
};
const query = (over: Partial<ForgePrSearch> = {}): ForgePrSearch => ({ ...search, ...over });

const failedCli: (request: CommandRequest) => Promise<CommandResult> = async () => ({
  code: 1,
  stdout: "secret-token abc",
  truncated: false,
});
const overflow: (request: CommandRequest) => Promise<CommandResult> = async () => ({
  code: 0,
  stdout: "x",
  truncated: true,
});
const offline: (request: CommandRequest) => Promise<CommandResult> = async () => ({
  code: 1,
  stdout: "",
  truncated: false,
  unreachable: true,
});
const wide: (request: CommandRequest) => Promise<CommandResult> = async () => ({
  code: 0,
  stdout: "é".repeat(5_000_000),
  truncated: false,
});

describe("origin reader", () => {
  it("reads status through origin api with a pinned head sha", async () => {
    const f = runner({ [detailEndpoint]: { body: pr() } });
    const reader = new OriginReader({ repository, runner: f.runner });
    const status = await reader.status(17, signal());
    expect(status).toMatchObject({
      title: "Add launch telemetry",
      headSha: HEAD,
      state: "open",
      ci: "unknown",
      mergeability: "unknown",
    });
    expect(status.url).toBe("https://cursor.com/codebase/acme/rocket/pull/17");
    expect(f.seen[0]?.args).toEqual(["api", detailEndpoint, "--method", "GET"]);
    expect(f.seen[0]).toMatchObject({ command: "origin", mode: "json" });
  });

  it("maps merged, closed and draft states", async () => {
    for (const [over, state] of [
      [{ merged: true, state: "closed" }, "merged"],
      [{ state: "closed" }, "closed"],
      [{ draft: true }, "draft"],
    ] as const) {
      const f = runner({ [detailEndpoint]: { body: pr(over) } });
      const reader = new OriginReader({ repository, runner: f.runner });
      expect((await reader.status(17, signal())).state).toBe(state);
    }
  });

  it("lists one page and derives counts across the traversal", async () => {
    const seen: CommandRequest[] = [];
    const f = runner(
      {
        [listEndpoint()]: {
          body: {
            pullRequests: [pr(), pr({ number: "18", title: "Second", draft: true })],
            nextPageToken: "cursor-a",
          },
        },
        [listEndpoint("&pageToken=cursor-a")]: {
          body: { pullRequests: [pr({ number: "19", state: "closed" })], nextPageToken: "" },
        },
      },
      seen,
    );
    const reader = new OriginReader({ repository, runner: f.runner });
    const page = await reader.listPrs(query({ state: "all" }), signal());
    expect(page.items).toHaveLength(3);
    expect(page.counts).toEqual({ open: 1, draft: 1, closed: 1, merged: 0 });
    expect(page.total).toBe(3);
    expect(page.truncated).toBe(false);
    expect(page.incomplete).toBe(false);
    expect(page.items[0]).toMatchObject({
      title: "Add launch telemetry",
      author: "jane",
      labels: ["bug"],
    });
  });

  it("filters by state and text on the client", async () => {
    const f = runner({
      [listEndpoint()]: {
        body: {
          pullRequests: [
            pr(),
            pr({ number: "18", title: "Unrelated", body: "Fixes a typo in the docs." }),
          ],
          nextPageToken: "",
        },
      },
    });
    const reader = new OriginReader({ repository, runner: f.runner });
    const drafts = await reader.listPrs(query({ state: "draft" }), signal());
    expect(drafts.total).toBe(0);
    const found = await reader.listPrs(
      query({ state: "all", search: "launch telemetry to the ignition" }),
      signal(),
    );
    expect(found.total).toBe(1);
    expect(found.items[0]?.title).toBe("Add launch telemetry");
  });

  it("marks the list truncated and incomplete at the thousand-item cap", async () => {
    const routes: Record<string, Route> = {};
    let token = "";
    for (let step = 0; step < 10; step++) {
      const next = step === 9 ? "cursor-last" : `cursor-${step}`;
      routes[listEndpoint(token === "" ? "" : `&pageToken=${token}`)] = {
        body: {
          pullRequests: Array.from({ length: 100 }, (_, index) =>
            pr({ number: String(step * 100 + index + 1) }),
          ),
          nextPageToken: next,
        },
      };
      token = next;
    }
    const f = runner(routes);
    const reader = new OriginReader({ repository, runner: f.runner });
    const page = await reader.listPrs(query({ state: "all" }), signal());
    expect(page.total).toBe(1000);
    expect(page.items).toHaveLength(25);
    expect(page.nextPage).toBe(2);
    expect(page.truncated).toBe(true);
    expect(page.incomplete).toBe(true);
    expect(f.seen).toHaveLength(10);
  });

  it("rejects unsupported filters instead of ignoring them", async () => {
    const f = runner({});
    const reader = new OriginReader({ repository, runner: f.runner });
    await expect(reader.listPrs(query({ ci: "failure" }), signal())).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(reader.listPrs(query({ review: "approved" }), signal())).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(reader.listPrs(query({ author: "jane" }), signal())).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(reader.listPrs(query({ reviewer: "jane" }), signal())).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(reader.listPrs(query({ sort: "comments" }), signal())).rejects.toMatchObject({
      kind: "unsupported",
    });
    expect(f.seen).toHaveLength(0);
  });

  it("marks detail read-only with unavailable comments, checks, reviews and commits", async () => {
    const f = runner({ [detailEndpoint]: { body: pr() } });
    const reader = new OriginReader({ repository, runner: f.runner });
    const detail = await reader.prDetail(17, signal());
    expect(detail.readOnly).toBe(true);
    expect(detail.unavailableResources).toEqual(["comments", "checks", "reviews", "commits"]);
    expect(detail).toMatchObject({
      baseSha: BASE,
      commits: 0,
      changedFiles: 5,
      headBranch: "add-telemetry",
      baseBranch: "main",
    });
  });

  it("falls back to the canonical web URL when the server link is foreign", async () => {
    const f = runner({ [detailEndpoint]: { body: pr({ webUrl: "https://evil.example/x" }) } });
    const reader = new OriginReader({ repository, runner: f.runner });
    expect((await reader.prDetail(17, signal())).status.url).toBe(
      "https://cursor.com/codebase/acme/rocket/pull/17",
    );
  });

  it("reads files pinned to the version before and after the traversal", async () => {
    const seen: CommandRequest[] = [];
    const f = runner(
      {
        [detailEndpoint]: { body: pr() },
        [filesEndpoint()]: {
          body: {
            files: [
              {
                filename: "src/telemetry.ts",
                status: "modified",
                additions: 6,
                deletions: 3,
                patch: "@@ -1 +1 @@\n",
              },
            ],
            nextPageToken: "",
          },
        },
      },
      seen,
    );
    const reader = new OriginReader({ repository, runner: f.runner });
    const files = await reader.prFiles(
      { number: 17, page: 1, headSha: HEAD, baseSha: BASE },
      signal(),
    );
    expect(files.files[0]).toMatchObject({ path: "src/telemetry.ts", additions: 6, deletions: 3 });
    expect(files.truncated).toBe(false);
    expect(
      seen
        .filter((request) => (request.args[1] as string).includes("/files"))
        .map((request) => request.args[1]),
    ).toEqual([filesEndpoint()]);
    const detailCalls = seen.filter((request) => request.args[1] === detailEndpoint);
    expect(detailCalls).toHaveLength(2);
  });

  it("refuses files when the version moved before or after the read", async () => {
    const moved = runner({
      [detailEndpoint]: {
        body: pr({ version: { number: "4", headSha: "c".repeat(40), baseSha: BASE } }),
      },
    });
    await expect(
      new OriginReader({ repository, runner: moved.runner }).prFiles(
        { number: 17, page: 1, headSha: HEAD, baseSha: BASE },
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "head_moved" });

    let calls = 0;
    const flaky = runner({
      [detailEndpoint]: { body: pr() },
      [filesEndpoint()]: { body: { files: [], nextPageToken: "" } },
    });
    const counting = async (request: CommandRequest): Promise<CommandResult> => {
      if (request.args[1] === detailEndpoint && ++calls === 2)
        return {
          code: 0,
          stdout: JSON.stringify(
            pr({ version: { number: "4", headSha: "c".repeat(40), baseSha: BASE } }),
          ),
          truncated: false,
        };
      return flaky.runner(request);
    };
    await expect(
      new OriginReader({ repository, runner: counting }).prFiles(
        { number: 17, page: 1, headSha: HEAD, baseSha: BASE },
        signal(),
      ),
    ).rejects.toMatchObject({ kind: "head_moved" });
  });

  it("rejects file ranges the API cannot pin", async () => {
    const f = runner({});
    const reader = new OriginReader({ repository, runner: f.runner });
    await expect(
      reader.prFiles({ number: 17, page: 1, headSha: HEAD, baseSha: BASE, commit: HEAD }, signal()),
    ).rejects.toMatchObject({ kind: "unsupported" });
    expect(f.seen).toHaveLength(0);
  });

  it("checks out the same repository with pinned shas", async () => {
    const f = runner({ [detailEndpoint]: { body: pr() } });
    const reader = new OriginReader({ repository, runner: f.runner });
    const checkout = await reader.prCheckout(17, signal());
    expect(checkout).toMatchObject({
      headSha: HEAD,
      baseSha: BASE,
      headBranch: "add-telemetry",
      baseBranch: "main",
    });
    expect(checkout.headRepository).toEqual(repository);
  });

  it("reads decimal-string numbers and rejects malformed ones", async () => {
    const f = runner({ [detailEndpoint]: { body: pr({ number: "017" }) } });
    expect(
      (await new OriginReader({ repository, runner: f.runner }).status(17, signal())).ref.number,
    ).toBe(17);
    const bad = runner({ [detailEndpoint]: { body: pr({ number: "17a" }) } });
    await expect(
      new OriginReader({ repository, runner: bad.runner }).status(17, signal()),
    ).rejects.toMatchObject({ kind: "invalid_data" });
  });

  it("sanitizes CLI failures without leaking output", async () => {
    const failure = await new OriginReader({ repository, runner: failedCli })
      .status(17, signal())
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ForgeError);
    expect(String(failure?.message)).not.toContain("secret-token");
    const missing = runner({});
    await expect(
      new OriginReader({ repository, runner: missing.runner }).status(99, signal()),
    ).rejects.toMatchObject({ kind: "not_found" });

    await expect(
      new OriginReader({ repository, runner: overflow }).status(17, signal()),
    ).rejects.toMatchObject({ kind: "limit" });

    await expect(
      new OriginReader({ repository, runner: offline }).status(17, signal()),
    ).rejects.toMatchObject({ kind: "offline" });
  });

  it("rejects non-origin hosts and malformed repositories as ForgeError", async () => {
    const f = runner({});
    expect(
      () =>
        new OriginReader({ repository: { ...repository, host: "cursor.com" }, runner: f.runner }),
    ).toThrowError(ForgeError);
    expect(
      () =>
        new OriginReader({ repository: { ...repository, host: "cursor.com" }, runner: f.runner }),
    ).toThrowError(expect.objectContaining({ kind: "unsupported" }));
    expect(
      () => new OriginReader({ repository: { ...repository, name: "" }, runner: f.runner }),
    ).toThrowError(ForgeError);
    expect(f.seen).toHaveLength(0);
  });

  it("reports unknown lifecycle states as unknown, never open", async () => {
    const f = runner({ [detailEndpoint]: { body: pr({ state: "queued" }) } });
    const status = await new OriginReader({ repository, runner: f.runner }).status(17, signal());
    expect(status.state).toBe("unknown");
    expect(status.state).not.toBe("open");
  });

  it("drops an unknown lifecycle state from listings and marks them incomplete", async () => {
    const f = runner({
      [listEndpoint()]: {
        body: { pullRequests: [pr(), pr({ number: "18", state: "queued" })], nextPageToken: "" },
      },
    });
    const page = await new OriginReader({ repository, runner: f.runner }).listPrs(
      query({ state: "all" }),
      signal(),
    );
    expect(page.items.map((item) => item.ref.number)).toEqual([17]);
    expect(page.incomplete).toBe(true);
  });

  it("turns list pages from one traversal within the snapshot window, then reads again", async () => {
    const seen: CommandRequest[] = [];
    const rows = Array.from({ length: 30 }, (_, index) => pr({ number: String(index + 1) }));
    const f = runner(
      { [listEndpoint()]: { body: { pullRequests: rows, nextPageToken: "" } } },
      seen,
    );
    let now = 1_000;
    const snapshots = new OriginListSnapshots(() => now);
    const reader = () => new OriginReader({ repository, runner: f.runner, snapshots });
    expect((await reader().listPrs(query({ state: "all" }), signal())).items).toHaveLength(25);
    const second = await reader().listPrs(query({ state: "open", page: 2 }), signal());
    expect(second.items).toHaveLength(5);
    expect(seen).toHaveLength(1);
    now += 30_000;
    await reader().listPrs(query({ state: "all" }), signal());
    expect(seen).toHaveLength(2);
  });

  it("keeps a pull request whose text exceeds protocol bounds, cut to fit", async () => {
    const labels = Array.from({ length: 1_500 }, (_, index) => ({ name: `l${index}` }));
    const f = runner({
      [detailEndpoint]: {
        body: pr({ body: "b".repeat(70_000), title: "t".repeat(70_000), labels }),
      },
    });
    const detail = await new OriginReader({ repository, runner: f.runner }).prDetail(17, signal());
    expect(detail.body).toHaveLength(65_536);
    expect(detail.status.title).toHaveLength(65_536);
    expect(detail.labels).toHaveLength(100);
  });

  it("treats a missing page token as a complete page", async () => {
    const seen: CommandRequest[] = [];
    const f = runner({ [listEndpoint()]: { body: { pullRequests: [pr()] } } }, seen);
    const page = await new OriginReader({ repository, runner: f.runner }).listPrs(
      query({ state: "all" }),
      signal(),
    );
    expect(page.total).toBe(1);
    expect(page.nextPage).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("rejects credential-bearing server URLs even on the canonical path", async () => {
    const f = runner({
      [detailEndpoint]: {
        body: pr({ webUrl: "https://jane:s3cret@cursor.com/codebase/acme/rocket/pull/17" }),
      },
    });
    const detail = await new OriginReader({ repository, runner: f.runner }).prDetail(17, signal());
    expect(detail.status.url).toBe("https://cursor.com/codebase/acme/rocket/pull/17");
    expect(detail.status.url).not.toContain("s3cret");
  });

  it("returns ForgeError rather than raw ZodError for malformed pins", async () => {
    const f = runner({});
    const reader = new OriginReader({ repository, runner: f.runner });
    const badPin = await reader
      .prFiles({ number: 17, page: 1, headSha: "not-a-sha", baseSha: BASE }, signal())
      .catch((error) => error);
    expect(badPin).toBeInstanceOf(ForgeError);
    expect(badPin).toMatchObject({ kind: "invalid_data" });
    const badPage = await reader
      .prFiles({ number: 17, page: 0, headSha: HEAD, baseSha: BASE }, signal())
      .catch((error) => error);
    expect(badPage).toBeInstanceOf(ForgeError);
    expect(badPage).toMatchObject({ kind: "invalid_data" });
    expect(f.seen).toHaveLength(0);
  });

  it("aggregates the page truncated flag into each file", async () => {
    const routes: Record<string, Route> = {};
    for (let step = 0; step < 40; step++) {
      routes[filesEndpoint(step === 0 ? "" : `&pageToken=t${step}`)] = {
        body: {
          files: [{ filename: `f${step}.ts`, status: "modified", additions: 1, deletions: 0 }],
          nextPageToken: `t${step + 1}`,
        },
      };
    }
    const f = runner({ ...routes, [detailEndpoint]: { body: pr() } });
    const reader = new OriginReader({ repository, runner: f.runner });
    const files = await reader.prFiles(
      { number: 17, page: 1, headSha: HEAD, baseSha: BASE },
      signal(),
    );
    expect(files.truncated).toBe(true);
    expect(files.files).toHaveLength(25);
    expect(files.files[0]?.truncated).toBe(true);
  });

  it("counts the read budget in UTF-8 bytes, not JS characters", async () => {
    await expect(
      new OriginReader({ repository, runner: wide }).status(17, signal()),
    ).rejects.toMatchObject({ kind: "limit" });
  });
});
