import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { forgeIdentityFixture } from "./forge-identity-test-support.ts";

const reply = (id: string, owner = "octo", name = "ace") =>
  Command.parse({
    id,
    deviceId: "device",
    payload: {
      type: "forge.comment.reply",
      link: {
        threadId: "identity-thread",
        pr: {
          number: 7,
          repository: { forge: "github", host: "git.example.com", owner, name },
        },
      },
      commentId: 13,
      body: "Fixed",
    },
  });

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
    restarted = new WorkspaceRuntime(f.store, f.root, () => 1000, {
      sourceControl: f.sourceControl,
    });
    expect(await restarted.execute(reply("first"))).toEqual(result);
    expect(await restarted.execute(reply("retry"))).toMatchObject({ ok: true, pr: { number: 7 } });
    expect((await f.facts()).replies).toHaveLength(1);
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test("a changed remote receipt prevents another reply write", async () => {
  const f = await forgeIdentityFixture();
  try {
    await f.update({ switchAfterReply: true });
    expect(await f.runtime.execute(reply("first"))).toMatchObject({
      error: "forge_outcome_uncertain",
    });
    const facts = await f.facts();
    await f.update({
      account: "octo",
      switchAfterReply: false,
      replies: facts.replies.map((value) => Object.assign(value, { body: "Edited externally" })),
    });
    expect(await f.runtime.execute(reply("retry"))).toMatchObject({
      ok: false,
      error: "forge_outcome_uncertain",
    });
    expect((await f.facts()).replies).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a lost reply response reconciles a new comment instead of an identical older reply", async () => {
  const f = await forgeIdentityFixture();
  try {
    await f.update({
      lostReply: true,
      replies: [
        {
          id: 31,
          body: "Fixed",
          user: { login: "octo" },
          in_reply_to_id: 13,
          updated_at: "2026-10-10T12:00:00Z",
        },
      ],
    });
    expect(await f.runtime.execute(reply("lost"))).toMatchObject({
      ok: false,
      error: "forge_outcome_uncertain",
    });
    expect((await f.facts()).replies).toHaveLength(2);
    expect(await f.runtime.execute(reply("reconciled"))).toMatchObject({ ok: true });
    expect((await f.facts()).replies).toHaveLength(2);
  } finally {
    await f.close();
  }
});


test("a malformed write preflight fails without reserving an uncertain reply and a fresh command can write", async () => {
  const f = await forgeIdentityFixture();
  try {
    await f.update({ invalidUser: 4 });
    expect(await f.runtime.execute(reply("invalid-preflight"))).toMatchObject({
      ok: false, error: "forge_invalid_data",
    });
    expect((await f.facts()).replies).toHaveLength(0);
    expect(await f.runtime.execute(reply("fresh-after-preflight"))).toMatchObject({ ok: true });
    expect((await f.facts()).replies).toHaveLength(1);
  } finally { await f.close(); }
});


test("a timed out write preflight keeps its CLI failure and a new command can retry", async () => {
  const f = await forgeIdentityFixture({ timeoutMs: 5000 });
  try {
    await f.update({ holdUser: 4 });
    const pending = f.runtime.execute(reply("timed-out-preflight"));
    await f.held();
    expect(await pending).toMatchObject({ ok: false, error: "forge_cli" });
    expect((await f.facts()).replies).toHaveLength(0);
    await f.release();
    expect(await f.runtime.execute(reply("retry-after-timeout"))).toMatchObject({ ok: true });
    expect((await f.facts()).replies).toHaveLength(1);
  } finally { await f.close(); }
}, 20000);


test("case-equivalent repositories reconcile the same uncertain reply after a restart", async () => {
  const f = await forgeIdentityFixture();
  let restarted: WorkspaceRuntime | undefined;
  try {
    await f.update({ lostReply: true });
    expect(await f.runtime.execute(reply("mixed-case", "Octo", "Ace"))).toMatchObject({
      ok: false, error: "forge_outcome_uncertain",
    });
    await f.runtime.close();
    restarted = new WorkspaceRuntime(f.store, f.root, () => 1000, { sourceControl: f.sourceControl });
    expect(await restarted.execute(reply("lower-case"))).toMatchObject({ ok: true });
    expect((await f.facts()).replies).toHaveLength(1);
  } finally { await restarted?.close(); await f.close(); }
});


test("a concurrent retry cannot reconcile or clear a receipt while its writer is waiting for a lost response", async () => {
  const f = await forgeIdentityFixture();
  try {
    await f.update({ lostReply: true, holdReply: true });
    const writer = f.runtime.execute(reply("active-writer", "Octo", "Ace"));
    await f.held();
    let reconciled = false;
    const retry = f.runtime.execute(reply("concurrent-reconciliation"))
      .then((result) => { reconciled = true; return result; });
    // Real filesystem/Git work yields while the second command can enter the daemon.
    await f.runtime.details(f.thread.id);
    expect(reconciled).toBe(false);
    await f.release();
    expect(await writer).toMatchObject({ ok: false, error: "forge_outcome_uncertain" });
    expect(await retry).toMatchObject({ ok: true });
    expect((await f.facts()).replies).toHaveLength(1);
  } finally { await f.release(); await f.close(); }
});
