import { expect, test } from "vitest";
import { Command } from "@ace/protocol";
import { forgeIdentityFixture } from "./forge-identity-test-support.ts";

const reply = (id: string) =>
  Command.parse({
    id,
    deviceId: "device",
    payload: {
      type: "forge.comment.reply",
      link: {
        threadId: "identity-thread",
        pr: {
          number: 7,
          repository: { forge: "github", host: "git.example.com", owner: "octo", name: "ace" },
        },
      },
      commentId: 13,
      body: "Fixed",
    },
  });
const changeAccount = (f: Awaited<ReturnType<typeof forgeIdentityFixture>>) =>
  f.settings.set(
    "sourceControl.preferences",
    {
      ...f.preferences,
      hosts: f.preferences.hosts.map((entry) => ({ ...entry, account: "other" })),
    },
    { kind: "global" },
  );

test("preferences changed during a write's preflight probe prevent the old account from writing", async () => {
  const f = await forgeIdentityFixture();
  try {
    // Admission and baseline comment read precede the write preflight (probe 4).
    await f.update({ holdUser: 4 });
    const result = f.runtime.execute(reply("changing"));
    await f.held();
    await changeAccount(f);
    await f.release();
    expect(await result).toMatchObject({ ok: false, error: "forge_preferences_changed" });
    expect((await f.facts()).replies).toHaveLength(0);
    await f.update({ account: "other", holdUser: 0 });
    expect(await f.runtime.execute(reply("fresh"))).toMatchObject({ ok: true });
    expect((await f.facts()).replies[0]?.user.login).toBe("other");
  } finally {
    await f.close();
  }
});

test("a preference change during the final probe preserves the reply but prevents publishing a successful result", async () => {
  const f = await forgeIdentityFixture();
  try {
    // Admission and baseline read consume three probes; write postflight is probe 5.
    await f.update({ holdUser: 5 });
    const result = f.runtime.execute(reply("changing"));
    await f.held();
    await changeAccount(f);
    await f.release();
    expect(await result).toMatchObject({ ok: false, error: "forge_outcome_uncertain" });
    expect((await f.facts()).replies).toHaveLength(1);
    expect(f.store.getThread(f.thread.id)?.details?.linkedPr).toBeUndefined();
    await f.settings.set("sourceControl.preferences", f.preferences, { kind: "global" });
    await f.update({ holdUser: 0 });
    expect(await f.runtime.execute(reply("reconciled"))).toMatchObject({ ok: true });
    expect((await f.facts()).replies).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a preference change during a status read prevents old capabilities from being published", async () => {
  const f = await forgeIdentityFixture();
  try {
    await f.update({ holdPath: "repos/octo/ace/pulls/7" });
    const result = f.runtime.execute(
      Command.parse({
        id: "link",
        deviceId: "device",
        payload: {
          type: "forge.pr.link",
          link: {
            threadId: f.thread.id,
            pr: {
              repository: { forge: "github", host: "git.example.com", owner: "octo", name: "ace" },
              number: 7,
            },
          },
        },
      }),
    );
    await f.held();
    await changeAccount(f);
    await f.release();
    expect(await result).toMatchObject({ ok: false, error: "forge_preferences_changed" });
    expect(f.store.getThread(f.thread.id)?.details?.linkedPr).toBeUndefined();
  } finally {
    await f.close();
  }
});


test("changing the expected account during initial backend admission prevents every admitted mutation", async () => {
  for (const type of ["forge.comment.reply", "forge.review.request", "forge.pr.merge", "forge.pr.auto-merge"] as const) {
    const f = await forgeIdentityFixture();
    try {
      await f.update({ holdUser: 1 });
      const base = reply(`initial-${type}`);
      const link = "link" in base.payload ? base.payload.link : undefined;
      const payload = type === "forge.comment.reply" ? base.payload
        : type === "forge.review.request" ? { type, link, reviewers: ["reviewer"] }
        : { type, link, headSha: "a".repeat(40), method: "squash" };
      const operation = f.runtime.execute(Command.parse({ ...base, payload }));
      await f.held();
      await changeAccount(f);
      await f.update({ account: "other" });
      await f.release();
      expect(await operation).toMatchObject({ ok: false, error: "forge_preferences_changed" });
      expect((await f.facts()).replies).toHaveLength(0);
    } finally { await f.release(); await f.close(); }
  }
});
