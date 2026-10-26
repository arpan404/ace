import "./test-host.ts";
import { expect, test } from "vitest";
import type { FilesReply } from "./forge-code.ts";
import type { CompleteReply, ReviewersReply } from "./forge-people.ts";
import type { ReviewWriteReply } from "./forge-review-write.ts";
import { connected } from "./forge-test-fixture.ts";

/*
 * People on the phone's pull requests, on the fake daemon's GitHub: `@` and `#` completion, the
 * reviewers list of #31 in acme/docs-site (the viewer's own PR, changes requested by mira), and
 * the changed files list.
 */

const docs = { forge: "github", host: "github.com", owner: "acme", name: "docs-site" } as const;
const pr31 = { project: "ace", number: 31, repository: docs };
type Ask = (request: Record<string, unknown>) => Promise<unknown>;
const completeAt = async (ask: Ask, text: string, at = text.length, extra = {}) =>
  (await ask({
    type: "forge.complete",
    project: "ace",
    text,
    start: at,
    end: at,
    ...extra,
  })) as CompleteReply;
const applied = (text: string, item: CompleteReply["items"][number]) =>
  text.slice(0, item.from) + item.insert + text.slice(item.to);

test("@ after a space suggests people, the pull request's own first, and a pick writes the mention", async () => {
  const { ask } = await connected();
  const reply = await completeAt(ask, "Thanks @ol", undefined, {
    on: { kind: "pull", number: 31 },
    repository: docs,
  });
  expect(reply.items[0]).toMatchObject({ label: "@ola", detail: "Ola Nordmann" });
  const pick = reply.items[0];
  if (!pick) throw new Error("no suggestion");
  expect(applied("Thanks @ol", pick)).toBe("Thanks @ola ");
  expect(pick.caret).toBe("Thanks @ola ".length);
});

test("# suggests issues and pull requests by number, and nothing completes inside code or an address", async () => {
  const { ask } = await connected();
  const numbered = await completeAt(ask, "Fixes #24");
  expect(numbered.items.map((item) => item.label)).toContain("#245");
  expect((await completeAt(ask, "mail me at a@b")).items).toEqual([]);
  expect((await completeAt(ask, "run `@mi")).items).toEqual([]);
});

test("the reviewers list says where each stands and what this account may ask; a re-request moves them back to awaiting", async () => {
  const { ask } = await connected();
  const read = async () => (await ask({ type: "forge.pull.reviewers", ...pr31 })) as ReviewersReply;
  const before = await read();
  const mira = before.rows.find((row) => row.name === "mira");
  expect(mira).toMatchObject({
    words: "Changes requested",
    canRerequest: true,
    canDismiss: true,
    reviewId: 9312,
  });
  expect(before.suggested.map((person) => person.login)).toEqual(["jonas", "priya", "kenji"]);
  const written = (await ask({
    type: "forge.review",
    ...pr31,
    action: { kind: "reviewers.request", reviewers: ["mira"] },
  })) as ReviewWriteReply;
  expect(written.ok).toBe(true);
  const after = (await read()).rows.find((row) => row.name === "mira");
  expect(after).toMatchObject({
    words: "Changes requested · asked again",
    canRerequest: false,
    canRemove: true,
  });
});

test("dismissing a review says why and turns it into a dismissed one", async () => {
  const { ask, sent } = await connected();
  const written = (await ask({
    type: "forge.review",
    ...pr31,
    action: { kind: "review.dismiss", reviewId: 9312, message: "Addressed in the last push." },
  })) as ReviewWriteReply;
  expect(written.ok).toBe(true);
  expect(sent[0]).toMatchObject({ action: { kind: "review.dismiss", reviewId: 9312 } });
  const rows = ((await ask({ type: "forge.pull.reviewers", ...pr31 })) as ReviewersReply).rows;
  expect(rows.find((row) => row.name === "mira")).toMatchObject({
    words: "Dismissed",
    canDismiss: false,
  });
});

test("the changed files list every file with its open conversations", async () => {
  const { ask } = await connected();
  const reply = (await ask({ type: "forge.pull.files", ...pr31 })) as FilesReply;
  expect(reply.files.map((file) => file.path)).toEqual([
    "docs/install.md",
    "docs/service.md",
    "docs/troubleshooting.md",
    "docs/docker.md",
    "sidebar.json",
  ]);
  // install.md holds two open conversations; troubleshooting.md's one is resolved.
  expect(reply.files.find((file) => file.path === "docs/install.md")?.conversations).toBe(2);
  expect(reply.files.find((file) => file.path === "docs/troubleshooting.md")?.conversations).toBe(
    0,
  );
  expect(reply.more).toBe(false);
});
