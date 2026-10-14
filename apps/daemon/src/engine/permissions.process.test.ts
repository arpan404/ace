import { Engine } from "@ace/daemon";
import { expect, test } from "vitest";
import { opencodeNative } from "@ace/provider-kit/access-modes";
import { harness, scriptFrames, start, end } from "./test-support.ts";
import { createClaudeAdapter } from "@ace/adapter-claude";
const capabilities = createClaudeAdapter().capabilities({
  installed: true,
  version: "2.1.286",
  auth: "logged_in",
  loginHint: "unused",
});
test("a thread stores its ace mode and the provider receives that mode's exact native setting", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    { provider: "claude", capabilities },
  );
  try {
    const result = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "claude",
      access: "read-only",
      input: [{ type: "text", text: "fake" }],
    });
    expect(result.ok).toBe(true);
    if (!result.threadId) throw new Error("No thread");
    await h.engine.flush();
    expect(h.contexts[0]?.permissionMode).toBe("plan");
    expect(h.store.getThread(result.threadId)?.permission).toEqual({
      override: "read-only",
      effective: "read-only",
      pending: false,
    });
    expect(
      h.command({ type: "thread.permission.set", threadId: result.threadId, access: "full-access" })
        .ok,
    ).toBe(true);
    expect(h.store.getThread(result.threadId)?.permission).toEqual({
      override: "full-access",
      effective: "read-only",
      pending: true,
    });
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

test.each([
  ["plan", "bypassPermissions", { override: "read-only", effective: "full-access" }],
  ["default", "dontAsk", { override: "ask", effective: "ask" }],
  ["acceptEdits", "auto", { override: "auto-review", effective: "auto-review" }],
] as const)(
  "stored native Claude modes %s/%s map once to ace modes and stay mapped after another restart",
  async (override, effective, expected) => {
    const frames = scriptFrames();
    const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
      provider: "claude",
      capabilities,
    });
    try {
      const id = await h.create();
      await h.engine.close();
      // The durable representation written before the four ace modes.
      h.store.atomic((db) => {
        db.prepare("UPDATE engine_permissions SET override=?,effective=? WHERE thread_id=?").run(
          override,
          effective,
          id,
        );
        // The thread row and its event recorded the same native ids.
        for (const [table, column, key] of [
          ["threads", "provider_metadata", "id"],
          ["events", "payload", "thread_id"],
        ] as const)
          db.prepare(
            `UPDATE ${table} SET ${column}=json_set(${column},'$.permission',json(?)) WHERE ${key}=? AND json_extract(${column},'$.permission') IS NOT NULL`,
          ).run(JSON.stringify({ override, effective, pending: false }), id);
      });
      for (let restart = 0; restart < 2; restart++) {
        const engine = new Engine(h.store, { registry: h.registry, clock: h.clock });
        try {
          await engine.ready();
          expect(h.store.getThread(id)?.permission).toMatchObject(expected);
        } finally {
          await engine.close();
        }
      }
    } finally {
      await h.close();
    }
  },
);

test("an unprofiled ACP agent offers no ace mode, so choosing one is refused", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    provider: "acp",
  });
  try {
    const id = await h.create();
    expect(
      h.command({ type: "thread.permission.set", threadId: id, access: "read-only" }),
    ).toMatchObject({ ok: false, error: "permission_mode_unsupported" });
    expect(h.store.getThread(id)?.permission?.override).toBeNull();
  } finally {
    await h.close();
  }
});

test("a default the provider lacks runs as the nearest stricter mode it supports", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    provider: "opencode",
    permissionSettings: async () => ({ access: "auto-review" }),
  });
  try {
    const id = await h.create();
    expect(h.contexts[0]?.permissionMode).toBe(opencodeNative.ask);
    expect(h.store.getThread(id)?.permission).toMatchObject({ override: null, effective: "ask" });
  } finally {
    await h.close();
  }
});

test("an Advanced native override runs instead of the ace mode and reads as Custom", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    provider: "claude",
    capabilities,
    permissionSettings: async () => ({ access: "full-access", custom: "dontAsk" }),
  });
  try {
    const id = await h.create();
    expect(h.contexts[0]?.permissionMode).toBe("dontAsk");
    expect(h.store.getThread(id)?.permission).toMatchObject({
      effective: null,
      custom: "dontAsk",
    });
  } finally {
    await h.close();
  }
});
