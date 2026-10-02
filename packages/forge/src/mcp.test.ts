import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { ForgeStore, createForgeToolkit } from "./index.ts";
import { fakeGh, standard, repository, pr } from "./testing/fixtures.ts";
const link = { threadId: "thread-1", pr: { repository, number: 7 } };
const signal = () => new AbortController().signal;
it("scopes MCP linking, creation and replies to the authorised thread and branch", async () => {
  const fixtures = standard();
  fixtures["repos/octo/ace/pulls"] = [{ body: pr }];
  fixtures["repos/octo/ace/pulls/7/comments/13/replies"] = [{ body: { id: 25 } }];
  const fake = await fakeGh(fixtures);
  const db = new DatabaseSync(":memory:");
  const store = new ForgeStore(db);
  store.link(link);
  const forge = fake.forge;
  try {
    const toolkit = createForgeToolkit({
      forge,
      store,
      threadId: link.threadId,
      branch: "feat/fix",
    });
    await expect(toolkit.call("forge_pr_status", { number: 8 }, signal())).rejects.toMatchObject({
      kind: "forbidden",
    });
    await expect(
      toolkit.call("forge_link_pr", { number: 7, threadId: "other" }, signal()),
    ).rejects.toMatchObject({ kind: "invalid_data" });
    expect(await toolkit.call("forge_link_pr", { number: 7 }, signal())).toEqual(link);
    expect(
      await toolkit.call(
        "forge_reply_comment",
        { number: 7, commentId: 13, body: "fixed" },
        signal(),
      ),
    ).toEqual({ ok: true });
    const input = {
      branch: "other",
      base: "main",
      title: "Fix",
      summary: "Fixed",
      template: { title: "{{title}}", body: "{{summary}}" },
    };
    await expect(toolkit.call("forge_create_pr", input, signal())).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(
      await toolkit.call("forge_create_pr", { ...input, branch: "feat/fix" }, signal()),
    ).toEqual(link);
    expect(await toolkit.call("forge_pr_status", { number: 7 }, signal())).toMatchObject({
      state: "open",
    });
  } finally {
    db.close();
    await fake.cleanup();
  }
});
