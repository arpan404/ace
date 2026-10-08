import { Engine } from "@ace/daemon";
import { expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";
import { createClaudeAdapter } from "@ace/adapter-claude";
const capabilities = createClaudeAdapter().capabilities({
  installed: true,
  version: "2.1.286",
  auth: "logged_in",
  loginHint: "unused",
});
test("a legacy client selects a native mode once and only the native id is stored", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    provider: "claude",
    capabilities,
  });
  try {
    const result = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "claude",
      permissionMode: "read-only",
      input: [{ type: "text", text: "fake" }],
    });
    expect(result.ok).toBe(true);
    if (!result.threadId) throw new Error("No thread");
    await h.engine.flush();
    expect(h.contexts[0]?.permissionMode).toBe("plan");
    expect(h.store.getThread(result.threadId)?.permission?.override).toBe("plan");
    expect(
      h.command({
        type: "thread.permission.set",
        threadId: result.threadId,
        permissionMode: "full-access",
      }).ok,
    ).toBe(true);
    expect(h.store.getThread(result.threadId)?.permission?.override).toBe("bypassPermissions");
  } finally {
    await h.close();
  }
});
test("a native approval stays pending without ace review and a permanent grant round-trips", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "interaction.opened",
            agent: "root",
            interaction: "approval",
            blocking: true,
            request: {
              kind: "approval",
              title: "native",
              options: [
                { id: "always", label: "Always allow", kind: "allow_always" },
                { id: "no", label: "No", kind: "deny" },
              ],
            },
          }),
        ],
      },
      { on: "resolve", frames: [frames.frame(end)] },
    ],
    frames,
    { provider: "claude", capabilities },
  );
  try {
    const id = await h.create();
    const interaction = Object.values(h.store.snapshotThread(id).interactions)[0];
    if (!interaction) throw new Error("No native approval");
    expect(interaction.state).toBe("pending");
    expect(interaction.review).toBeUndefined();
    expect(h.store.getThread(id)?.status.state).toBe("needs_you");
    expect(
      h.command({
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId: "always" },
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.store.getInteraction(interaction.id)?.resolution).toMatchObject({
      kind: "approval",
      optionId: "always",
    });
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await h.close();
  }
});

test("stored legacy thread modes migrate on restart and remain native after another restart", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    provider: "claude",
    capabilities,
  });
  try {
    const id = await h.create();
    await h.engine.close();
    // Seed the durable representation written by the previous permission model.
    h.store.atomic((db) =>
      db
        .prepare("UPDATE engine_permissions SET override=?,effective=? WHERE thread_id=?")
        .run("read-only", "auto-review", id),
    );
    for (let restart = 0; restart < 2; restart++) {
      const engine = new Engine(h.store, { registry: h.registry, clock: h.clock });
      try {
        await engine.ready();
        expect(h.store.getThread(id)?.permission).toMatchObject({
          override: "plan",
          effective: "auto",
        });
      } finally {
        await engine.close();
      }
    }
  } finally {
    await h.close();
  }
});
