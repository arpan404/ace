import { afterEach, expect, test } from "vitest";
import type { ProviderKind, ThreadId } from "@ace/protocol";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
function setup() {
  const h = transitionHarness({ cursorBackend: "cursor-sdk" });
  cleanup.push(h.close);
  return h;
}
type Harness = ReturnType<typeof setup>;

const acpIdentity = {
  acpAgentId: "registered-agent",
  installationId: "registered-installation",
  instanceId: "registered-account",
};

/** A thread on `provider` that has answered "source history" once. */
async function started(h: Harness, provider: ProviderKind): Promise<ThreadId> {
  const before = new Set(h.store.listThreads().map((thread) => thread.id));
  const result = h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider,
    ...(provider === "acp" ? acpIdentity : {}),
    input: [{ type: "text", text: "source history" }],
  });
  if (!result.ok) throw new Error(result.error);
  await h.engine.flush();
  const id = h.store.listThreads().find((thread) => !before.has(thread.id))?.id;
  if (!id) throw new Error("No source thread");
  return id;
}

async function send(h: Harness, threadId: ThreadId, text: string) {
  expect(
    h.command({
      type: "thread.send",
      threadId,
      delivery: "queue",
      input: [{ type: "text", text }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
}

/** Every provider input that carried `text`, wherever it went. */
const deliveries = (h: Harness, text: string) =>
  h.inputs.filter((input) => input.text.split("\n").includes(text));

const inPlace = (["codex", "claude", "opencode", "pi", "acp"] as const).flatMap((from) =>
  (["codex", "claude", "cursor", "opencode", "pi"] as const)
    .filter((to) => to !== from)
    .map((to) => ({ from, to })),
);

test.each(inPlace)(
  "switching an existing $from thread to $to delivers the next message to $to with the prior context and exactly once",
  async ({ from, to }) => {
    const h = setup();
    const id = await started(h, from);
    const source = h.inputs.at(-1)?.nativeId;
    expect(h.command({ type: "thread.switch", threadId: id, selection: { provider: to } }).ok).toBe(
      true,
    );
    await h.engine.flush();
    expect(h.store.getThread(id)?.switch).toMatchObject({ state: "applied", lossy: true });
    await send(h, id, "next message");

    const delivered = deliveries(h, "next message");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.provider).toBe(to);
    expect(delivered[0]?.nativeId).not.toBe(source);
    // The new provider reads the earlier conversation through ace's portable handoff.
    expect(delivered[0]?.text).toContain(`"sourceThreadId":"${id}"`);
    expect(delivered[0]?.text).toContain("source history");
    // The same thread carries on: its identity and its history stay.
    expect(h.store.getThread(id)).toMatchObject({ id, provider: to });
    expect(h.store.listThreads()).toHaveLength(1);
  },
);

test.each(["codex", "claude", "cursor", "opencode", "pi"] as const)(
  "a %s model change keeps the native session and delivers the next message once",
  async (provider) => {
    const h = setup();
    const id = await started(h, provider);
    const native = h.inputs.at(-1)?.nativeId;
    expect(
      h.command({
        type: "thread.switch",
        threadId: id,
        selection: { provider, model: "model-b" },
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    await send(h, id, "next message");
    expect(deliveries(h, "next message")).toEqual([
      expect.objectContaining({ provider, nativeId: native, model: "model-b" }),
    ]);
  },
);

test.each([
  { label: "Codex", to: "codex" as const },
  { label: "Claude", to: "claude" as const },
  { label: "OpenCode", to: "opencode" as const },
  { label: "Pi", to: "pi" as const },
  { label: "another Cursor account", to: "cursor" as const, instanceId: "account-b" },
])(
  "a Cursor thread moving to $label continues in a new thread with its context, delivering the message once",
  async ({ to, instanceId }) => {
    const h = setup();
    const id = await started(h, "cursor");
    const checkpoint = h.inputs.at(-1)?.nativeId;
    const selection = { provider: to, ...(instanceId ? { instanceId } : {}) };
    // The engine says so up front, in a stable code; nothing is queued or failed later.
    expect(h.command({ type: "thread.switch", threadId: id, selection })).toMatchObject({
      ok: false,
      error: "switch_requires_new_thread",
    });
    await h.engine.flush();
    expect(h.store.getThread(id)?.switch).toBeUndefined();

    const result = h.command({
      type: "thread.fork",
      threadId: id,
      point: { type: "turn", runId: h.finishedRun(id).id },
      input: "next message",
      selection: { ...selection, options: {} },
      budgetBytes: 16384,
    });
    expect(result.ok).toBe(true);
    await h.engine.flush();
    const continued = result.forkThreadId;
    expect(h.store.getThread(continued ?? ("" as ThreadId))).toMatchObject({
      provider: to,
      lineage: { parentThreadId: id, mode: "portable", lossy: true },
    });
    const delivered = deliveries(h, "next message");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.provider).toBe(to);
    expect(delivered[0]?.nativeId).not.toBe(checkpoint);
    expect(delivered[0]?.text).toContain("source history");
    if (instanceId) expect(h.sessions.at(-1)?.context.instanceId).toBe(instanceId);
    // The Cursor thread keeps its pinned checkpoint and continues there if asked to.
    expect(h.store.getThread(id)).toMatchObject({ provider: "cursor", backend: "cursor-sdk" });
    await send(h, id, "back on Cursor");
    expect(deliveries(h, "back on Cursor")).toEqual([
      expect.objectContaining({ provider: "cursor", nativeId: checkpoint }),
    ]);
  },
);

test("an existing thread can't move to an ACP agent and keeps running where it was", async () => {
  const h = setup();
  const id = await started(h, "claude");
  expect(
    h.command({ type: "thread.switch", threadId: id, selection: { provider: "acp" } }),
  ).toMatchObject({ ok: false, error: "acp_identity_required" });
  await send(h, id, "next message");
  expect(deliveries(h, "next message")).toEqual([expect.objectContaining({ provider: "claude" })]);
});
