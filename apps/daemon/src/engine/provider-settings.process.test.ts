import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { harness, scriptFrames, start, end } from "./test-support.ts";

test("disabling a provider rejects new work while existing thread history remains readable", async () => {
  let enabled = true;
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    providerEnabled: () => enabled,
  });
  try {
    const id = await h.create();
    enabled = false;
    expect(
      h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "next" }] }),
    ).toMatchObject({ ok: false, error: "provider_disabled" });
    expect(
      h.command({
        type: "thread.create",
        provider: "codex",
        workspaceId: h.workspace,
        input: [{ type: "text", text: "new" }],
      }),
    ).toMatchObject({ ok: false, error: "provider_disabled" });
    expect(h.store.snapshotThread(ThreadId.parse(id))?.thread.id).toBe(id);
    enabled = true;
    expect(
      h.command({
        type: "thread.prepare",
        threadId: ThreadId.parse("enabled-thread"),
        workspaceId: h.workspace,
        provider: "codex",
        title: "Enabled again",
      }).ok,
    ).toBe(true);
  } finally {
    await h.close();
  }
});

test("explicit disabled accounts are refused before a new thread is admitted", async () => {
  const frames = scriptFrames();
  const h = await harness([], frames, {
    providerEnabled: (_provider, instance) => instance !== "disabled-account",
  });
  try {
    for (const selection of [{ accountId: "disabled-account" }, { instanceId: "disabled-account" }])
      expect(
        h.command({
          type: "thread.create",
          provider: "codex",
          workspaceId: h.workspace,
          input: [{ type: "text", text: "new" }],
          ...selection,
        }),
      ).toMatchObject({ ok: false, error: "provider_disabled" });
  } finally {
    await h.close();
  }
});
