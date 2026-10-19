import { afterEach, expect, test } from "vitest";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
test("an ACP fork retains its registered installation and passes the exact identity to its session", async () => {
  const h = transitionHarness();
  cleanup.push(h.close);
  const identity = {
    acpAgentId: "registered-agent",
    installationId: "registered-installation",
    instanceId: "registered-account",
  };
  expect(
    h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "acp",
      ...identity,
      input: [{ type: "text", text: "ACP source context" }],
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const source = h.store.listThreads()[0];
  if (!source) throw new Error("No ACP source");
  const fork = await h.fork(source.id);
  expect(h.store.getThread(fork)).toMatchObject({
    provider: "acp",
    ...identity,
    lineage: { parentThreadId: source.id, mode: "portable" },
  });
  expect(h.sessions.at(-1)?.context.acpIdentity).toEqual(identity);
  expect(h.inputs.at(-1)?.text).toContain("ACP source context");
});
test("a provider switch requiring an ACP identity rejects before changing the source selection", async () => {
  const h = transitionHarness();
  cleanup.push(h.close);
  const source = await h.create();
  expect(
    h.command({ type: "thread.switch", threadId: source, selection: { provider: "acp" } }),
  ).toMatchObject({ ok: false, error: "acp_identity_required" });
  await h.engine.flush();
  expect(h.store.getThread(source)?.provider).toBe("codex");
  expect(h.sessions[0]?.closed).toBe(false);
});

test("an ACP thread keeps its agent's login: another account is refused before anything changes", async () => {
  const h = transitionHarness({
    io: {
      applyPatch: async () => {},
      migrate: async () => ({ status: "unsupported", reason: "ACP has no native copy" }),
    },
    recovery: { moveTarget: () => "other-agent-account" },
  });
  cleanup.push(h.close);
  const identity = {
    acpAgentId: "registered-agent",
    installationId: "registered-installation",
    instanceId: "registered-account",
  };
  h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "acp",
    ...identity,
    input: [{ type: "text", text: "ACP source context" }],
  });
  await h.engine.flush();
  const source = h.store.listThreads()[0];
  if (!source) throw new Error("No ACP source");
  const original = h.sessions.at(-1)?.nativeId;
  expect(
    h.command({
      type: "thread.switch",
      threadId: source.id,
      selection: { provider: "acp", instanceId: "other-agent-account" },
    }),
  ).toMatchObject({ ok: false, error: "acp_account_fixed" });
  expect(
    h.command({
      type: "thread.limit",
      threadId: source.id,
      expectedRevision: h.engine.queue(source.id).revision,
      action: "migrate_now",
    }),
  ).toMatchObject({ ok: false, error: "acp_account_fixed" });
  await h.engine.flush();
  h.command({
    type: "thread.send",
    threadId: source.id,
    input: [{ type: "text", text: "follow up" }],
    delivery: "queue",
  });
  await h.engine.flush();
  expect(h.sessions.at(-1)?.context.acpIdentity).toEqual(identity);
  expect(h.inputs.at(-1)).toMatchObject({ nativeId: original, text: "follow up" });
});
