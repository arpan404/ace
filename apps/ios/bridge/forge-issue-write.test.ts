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
