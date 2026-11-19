import "./test-host.ts";
import { ForgePrSearch, WorkspaceId } from "@ace/protocol";
import { expect, test } from "vitest";
import type { StartFromPickReply, StartFromReply } from "./forge-start-from.ts";
import { connected } from "./forge-test-fixture.ts";

/*
 * Starting a thread from open work on the phone, on the fake daemon's GitHub: acme/ace's open
 * issues, and the open pull requests a test seeds (#12 passing, #9 failing its checks).
 */

const ace = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
type Ask = (request: Record<string, unknown>) => Promise<unknown>;
const pr = (number: number, title: string, ci: "success" | "failure") => ({
  ref: { repository: ace, number },
  title,
  url: `https://github.com/acme/ace/pull/${number}`,
  author: "dev",
  state: "open" as const,
  labels: [],
  updatedAt: "2026-10-18T10:00:00Z",
  ci,
});
type Daemon = Awaited<ReturnType<typeof connected>>["daemon"];
/** What the daemon answers for the open pull requests matching `search`. */
function seed(daemon: Daemon, items: ReturnType<typeof pr>[], query: Record<string, unknown> = {}) {
  daemon.workspace.setForgeRead(
    {
      op: "forge.pr.list",
      workspaceId: WorkspaceId.parse("ace"),
      query: ForgePrSearch.parse({ state: "active", ...query }),
    },
    {
      resource: "prList",
      value: {
        repository: ace,
        items,
        total: items.length,
        counts: { open: items.length, draft: 0, closed: 0, merged: 0 },
        incomplete: false,
        truncated: false,
      },
    },
  );
}
const withOpenWork = async () => {
  const fixture = await connected();
  // The daemon's order is newest first; the failing one leads anyway.
  seed(fixture.daemon, [
    pr(12, "Tidy the settings page", "success"),
    pr(9, "Fix reconnect loop", "failure"),
  ]);
  seed(fixture.daemon, [pr(9, "Fix reconnect loop", "failure")], { ci: "failure" });
  return fixture;
};
const open = async (ask: Ask, extra: Record<string, unknown> = {}) =>
  (await ask({ type: "forge.start-from", project: "ace", ...extra })) as StartFromReply;

test("open pull requests and issues are offered, failing checks first, with their totals", async () => {
  const { ask } = await withOpenWork();
  const reply = await open(ask);
  expect(reply.pullRequests).toMatchObject({ label: "Pull requests", total: 2, limit: 5 });
  expect(reply.pullRequests?.rows.map((row) => [row.number, row.note?.text ?? null])).toEqual([
    [9, "Checks failing"],
    [12, null],
  ]);
  expect(reply.issues?.label).toBe("Issues");
  expect(reply.issues?.rows.length).toBeGreaterThan(0);
});

test("picking a pull request opens the draft on its head, with what to work on", async () => {
  const { ask } = await connected();
  const picked = (await ask({
    type: "forge.start-from.pick",
    project: "ace",
    kind: "pullRequests",
    repository: ace,
    number: 233,
  })) as StartFromPickReply;
  expect(picked.text.startsWith("Work on GitHub PR #233: ")).toBe(true);
  expect(picked.text).toContain("fix/draft-per-project → main");
  expect(picked.pullRequest).toMatchObject({ repository: ace, number: 233 });
  expect(picked.pullRequest?.headSha).toMatch(/^[a-f0-9]{40}$/);
  expect(picked.issue).toBeNull();
});

test("picking an issue links the thread to it, with its body to start from", async () => {
  const { ask } = await connected();
  const [first] = (await open(ask)).issues?.rows ?? [];
  if (!first) throw new Error("no open issue");
  const picked = (await ask({
    type: "forge.start-from.pick",
    project: "ace",
    kind: "issues",
    repository: first.repository,
    number: first.number,
  })) as StartFromPickReply;
  expect(picked.text.startsWith(`Work on GitHub issue #${first.number}: ${first.title}`)).toBe(
    true,
  );
  expect(picked.issue).toMatchObject({ number: first.number });
  expect(picked.pullRequest).toBeNull();
});

test("searching one list asks GitHub, and a search with no matches says so", async () => {
  const { ask, daemon } = await withOpenWork();
  const all = await open(ask);
  seed(daemon, [pr(9, "Fix reconnect loop", "failure")], { search: "reconnect" });
  const found = await open(ask, { search: { kind: "pullRequests", text: "reconnect" } });
  expect(found.pullRequests?.rows.map((row) => row.number)).toEqual([9]);
  // The other list keeps its open work.
  expect(found.issues?.rows).toEqual(all.issues?.rows);
  seed(daemon, [], { search: "zzz" });
  const none = await open(ask, { search: { kind: "pullRequests", text: "zzz" } });
  expect(none.pullRequests).toMatchObject({ rows: [], none: "No open pull requests match." });
});

test("a project without a forge has nothing to start from, and the lists take no space", async () => {
  const { ask } = await connected();
  expect(await open(ask, { project: "no-such-project" })).toEqual({
    type: "forge.start-from",
    pullRequests: null,
    issues: null,
  });
});
