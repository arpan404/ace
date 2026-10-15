import { afterEach, expect, test } from "vitest";
import { GitHubForge, uncertainWriteWindowMs, type ReplyReceipts } from "./index.ts";
import type { ReplyReceipt } from "./reply-receipts.ts";
import { fakeGh, repository, standard } from "./testing/fixtures.ts";

const signal = () => new AbortController().signal;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function memoryReceipts(): ReplyReceipts {
  const rows = new Map<string, ReplyReceipt>();
  return {
    account: "octo",
    get: (intent) => rows.get(intent),
    reserve: (intent, before, at) => {
      if (rows.has(intent)) return false;
      rows.set(intent, { id: null, before, at, account: "octo" });
      return true;
    },
    put: (intent, id) => {
      const row = rows.get(intent);
      if (row) rows.set(intent, { ...row, id });
    },
    remove: (intent) => {
      rows.delete(intent);
    },
  };
}
const replies = "repos/octo/ace/pulls/7/comments/13/replies";

test("a reply that never landed blocks a resend only until the uncertainty window ends", async () => {
  const fixtures = standard();
  // The first send times out without a response; the host never shows the reply.
  fixtures[replies] = [{ status: 502 }, { status: 201, body: { id: 31 } }];
  fixtures["repos/octo/ace/pulls/7/comments?per_page=100"] = [{ body: [] }];
  const gh = await fakeGh(fixtures);
  cleanups.push(gh.cleanup);
  let clock = 1_000;
  const forge = new GitHubForge({
    repository,
    runner: gh.runner,
    command: gh.executable,
    now: () => clock,
    replyReceipts: memoryReceipts(),
  });
  await expect(forge.replyComment(7, 13, "Fixed", signal())).rejects.toMatchObject({
    kind: "outcome_uncertain",
  });
  await expect(forge.replyComment(7, 13, "Fixed", signal())).rejects.toMatchObject({
    kind: "outcome_uncertain",
  });
  clock += uncertainWriteWindowMs;
  await forge.replyComment(7, 13, "Fixed", signal());
  expect((await gh.requests()).filter((request) => request.path === replies)).toHaveLength(2);
});
