import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { forgeIdentityFixture } from "./forge-identity-test-support.ts";

const reply = (id: string) => Command.parse({ id, deviceId: "device", payload: {
  type: "forge.comment.reply", link: { threadId: "identity-thread", pr: { number: 7,
    repository: { forge: "github", host: "git.example.com", owner: "octo", name: "ace" },
  } }, commentId: 13, body: "Fixed",
} });

test("a successful reply followed by an account switch stays uncertain and a restart retry reconciles without duplicating it", async () => {
  const f = await forgeIdentityFixture();
  let restarted: WorkspaceRuntime | undefined;
  try {
    await f.update({ switchAfterReply: true });
    const result = await f.runtime.execute(reply("first"));
    expect(result).toMatchObject({ ok: false, error: "forge_outcome_uncertain" });
    expect((await f.facts()).replies).toHaveLength(1);
    await f.runtime.close();
    await f.update({ account: "octo", switchAfterReply: false });
    restarted = new WorkspaceRuntime(f.store, f.root, () => 1000, { sourceControl: f.sourceControl });
    expect(await restarted.execute(reply("first"))).toEqual(result);
    expect(await restarted.execute(reply("retry"))).toMatchObject({ ok: true, pr: { number: 7 } });
    expect((await f.facts()).replies).toHaveLength(1);
  } finally { await restarted?.close(); await f.close(); }
});

test("a changed remote receipt prevents another reply write", async () => {
  const f = await forgeIdentityFixture();
  try {
    await f.update({ switchAfterReply: true });
    expect(await f.runtime.execute(reply("first"))).toMatchObject({ error: "forge_outcome_uncertain" });
    const facts = await f.facts();
    await f.update({ account: "octo", switchAfterReply: false, replies: facts.replies.map((value) => ({ ...value, body: "Edited externally" })) });
    expect(await f.runtime.execute(reply("retry"))).toMatchObject({ ok: false, error: "forge_outcome_uncertain" });
    expect((await f.facts()).replies).toHaveLength(1);
  } finally { await f.close(); }
});
