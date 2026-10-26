import "./test-host.ts";
import { expect, test } from "vitest";
import type { ManageReply, ManageWriteReply } from "./forge-manage.ts";
import type { NewPrCompareReply, NewPrContextReply, NewPrCreateReply } from "./forge-new-pr.ts";
import type { PullReply } from "./forge-pull.ts";
import { connected } from "./forge-test-fixture.ts";

/*
 * Managing pull requests from the phone, on the fake daemon's GitHub: #233 in acme/ace sits in a
 * milestone and closes #240; #224's conversation is locked against this account.
 */

const ace = { forge: "github", host: "github.com", owner: "acme", name: "ace" } as const;
type Ask = (request: Record<string, unknown>) => Promise<unknown>;
const manage = async (ask: Ask, number: number) =>
  (await ask({ type: "forge.pull.manage", project: "ace", number })) as ManageReply;
const apply = async (ask: Ask, number: number, version: string, action: Record<string, unknown>) =>
  (await ask({
    type: "forge.manage",
    project: "ace",
    number,
    repository: ace,
    operation: { kind: "apply", version, action },
  })) as ManageWriteReply;

test("a pull request's milestone, closing issues, branch and lock read as the page shows them", async () => {
  const { ask } = await connected();
  const pr = await manage(ask, 233);
  expect(pr.milestone).toEqual({ number: 3, title: "October polish" });
  expect(pr.milestones?.map((each) => each.title)).toEqual([
    "October polish",
    "Mobile beta",
    "Later",
  ]);
  expect(pr.closingIssues).toMatchObject([{ number: 240, manual: false, state: { word: "Open" } }]);
  expect(pr.conversation).toMatchObject({ locked: false, lock: true, unlock: false });
  expect(pr.unconfirmed).toEqual([]);
  expect((await manage(ask, 224)).conversation).toMatchObject({
    locked: true,
    reason: "Too heated",
  });
});

test("moving to another milestone and locking are pinned to the version seen; a stale version is refused", async () => {
  const { ask } = await connected();
  const before = await manage(ask, 233);
  expect(
    await apply(ask, 233, before.version, { kind: "edit", changes: { milestone: 4 } }),
  ).toMatchObject({ ok: true });
  const moved = await manage(ask, 233);
  expect(moved.milestone?.title).toBe("Mobile beta");
  // The version from before the move no longer matches what GitHub has.
  const stale = await apply(ask, 233, before.version, { kind: "lock", reason: "resolved" });
  expect(stale).toMatchObject({ ok: false, uncertain: false });
  expect((await apply(ask, 233, moved.version, { kind: "lock", reason: "resolved" })).ok).toBe(
    true,
  );
  expect((await manage(ask, 233)).conversation).toMatchObject({
    locked: true,
    reason: "Resolved",
    unlock: true,
  });
});

test("a lifecycle write whose answer is lost is unconfirmed and sent only once", async () => {
  const { ask, sent } = await connected(undefined, undefined, () =>
    Promise.reject(new Error("socket closed")),
  );
  const pr = await manage(ask, 233);
  const reply = await apply(ask, 233, pr.version, { kind: "issue.link", issue: 238 });
  expect(reply).toMatchObject({ ok: false, uncertain: true });
  expect(sent).toHaveLength(1);
});

test("a merge sends the commit as the person edited it, starting from GitHub's prefill", async () => {
  const { ask, sent } = await connected();
  const page = (await ask({
    type: "forge.pull",
    project: "ace",
    number: 233,
    method: "squash",
  })) as PullReply;
  expect(page.commit?.title).toContain("(#233)");
  await ask({
    type: "forge.merge",
    project: "ace",
    number: 233,
    repository: ace,
    method: "squash",
    headSha: page.headSha,
    commit: { title: "Ship the pages", message: "Squashed from the phone." },
  });
  expect(sent.at(-1)).toMatchObject({
    commit: { title: "Ship the pages", message: "Squashed from the phone." },
  });
});

test("a new pull request opens from a branch, and asking again for the same branches finds it instead of a second", async () => {
  const { ask } = await connected();
  const context = (await ask({ type: "forge.newpr.context", project: "ace" })) as NewPrContextReply;
  expect(context.defaultBranch).toBe("main");
  expect(context.head.branches).toContain("feature/release-notes");
  const head = { owner: "acme", name: "ace", branch: "feature/release-notes" };
  const compare = (await ask({
    type: "forge.newpr.compare",
    project: "ace",
    repository: ace,
    base: "main",
    head,
  })) as NewPrCompareReply;
  expect(compare).toMatchObject({
    summary: "3 commits, 4 files changed",
    blocked: null,
    existing: null,
  });
  const create = {
    type: "forge.newpr.create",
    project: "ace",
    repository: ace,
    base: "main",
    head,
    title: "Release notes page",
    body: "",
    draft: false,
  };
  const opened = (await ask(create)) as NewPrCreateReply;
  expect(opened.ok).toBe(true);
  expect(opened.number).toBeGreaterThan(0);
  const again = (await ask(create)) as NewPrCreateReply;
  expect(again).toMatchObject({
    ok: true,
    number: opened.number,
    message: "These branches already have an open pull request.",
  });
});
