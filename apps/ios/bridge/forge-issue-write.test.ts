import "./test-host.ts";
import { expect, test } from "vitest";
import type { IssueReply } from "./forge-issue.ts";
import type { IssueWriteReply } from "./forge-issue-write.ts";
import { connected, repository } from "./forge-test-fixture.ts";

/* Commenting on an issue from the phone, on the fake daemon's GitHub (#240 in acme/ace). */

type Ask = (request: Record<string, unknown>) => Promise<unknown>;
const issue = async (ask: Ask) =>
  (await ask({ type: "forge.issue", project: "ace", number: 240 })) as IssueReply;
const comment = async (ask: Ask, body: string) =>
  (await ask({
    type: "forge.issue.comment",
    project: "ace",
    repository,
    number: 240,
    body,
  })) as IssueWriteReply;

test("a comment posted from the issue's box joins its conversation", async () => {
  const { ask } = await connected();
  expect((await issue(ask)).box).toEqual({ off: null });
  expect(await comment(ask, "Seen on the phone too.")).toMatchObject({
    ok: true,
    uncertain: false,
  });
  expect((await issue(ask)).events.some((event) => event.body === "Seen on the phone too.")).toBe(
    true,
  );
});

test("a comment GitHub didn't confirm is listed on the issue to check, and sent only once", async () => {
  const { ask, sent, daemon } = await connected();
  daemon.workspace.setIssueOutcome("uncertain");
  expect(await comment(ask, "Maybe posted.")).toMatchObject({ ok: false, uncertain: true });
  expect(sent).toHaveLength(1);
  const unconfirmed = (await issue(ask)).unconfirmed;
  expect(unconfirmed.map((each) => each.label)).toEqual(["Your comment"]);
  const checked = (await ask({
    type: "forge.issue.check",
    project: "ace",
    repository,
    actionId: unconfirmed[0]?.id,
  })) as IssueWriteReply;
  expect(checked.uncertain).toBe(false);
});

const change = async (ask: Ask, input: Record<string, unknown>) =>
  (await ask({ type: "forge.issue.change", project: "ace", repository, input })) as IssueWriteReply;

test("an issue closes as not planned and reopens, each from the issue as it was read", async () => {
  const { ask } = await connected();
  const before = await issue(ask);
  expect(before.state.word).toBe("Open");
  const closed = await change(ask, {
    action: "state",
    number: 240,
    expectedUpdatedAt: before.revision,
    state: "closed",
    reason: "not_planned",
  });
  expect(closed).toMatchObject({ ok: true, uncertain: false });
  const after = await issue(ask);
  expect(after.state.word).toBe("Closed");
  expect(
    (
      await change(ask, {
        action: "state",
        number: 240,
        expectedUpdatedAt: after.revision,
        state: "open",
      })
    ).ok,
  ).toBe(true);
  expect((await issue(ask)).state.word).toBe("Open");
});

test("an issue's title, description and labels change from the phone", async () => {
  const { ask } = await connected();
  const before = await issue(ask);
  const edited = await change(ask, {
    action: "edit",
    number: 240,
    expectedUpdatedAt: before.revision,
    title: "Phone keyboard covers the composer",
    body: "Seen on iPhone 18.",
    base: { title: before.title, body: before.body },
  });
  expect(edited.ok).toBe(true);
  expect(
    (await change(ask, { action: "labels", number: 240, add: ["mobile"], remove: [] })).ok,
  ).toBe(true);
  const after = await issue(ask);
  expect(after.title).toBe("Phone keyboard covers the composer");
  expect(after.labels.map((label) => label.name)).toContain("mobile");
});

test("a new issue opens from the phone and says which number it got", async () => {
  const { ask } = await connected();
  const created = await change(ask, { action: "create", title: "Crash on launch", body: "" });
  expect(created).toMatchObject({ ok: true, uncertain: false });
  expect(created.opened).toEqual(expect.any(Number));
  const opened = (await ask({
    type: "forge.issue",
    project: "ace",
    number: created.opened,
  })) as IssueReply;
  expect(opened.title).toBe("Crash on launch");
});
