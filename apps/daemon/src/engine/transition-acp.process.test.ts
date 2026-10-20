import { afterEach, expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
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

const agentA = {
  acpAgentId: "registered-agent",
  installationId: "registered-installation",
  instanceId: "registered-account",
};
const agentB = {
  acpAgentId: "registered-agent",
  installationId: "second-installation",
  instanceId: "second-account",
};
function acpHarness() {
  const h = transitionHarness({
    io: {
      applyPatch: async () => {},
      migrate: async () => ({ status: "unsupported", reason: "ACP has no native copy" }),
    },
    recovery: { moveTarget: () => agentB.instanceId },
  });
  cleanup.push(h.close);
  return h;
}
async function send(h: ReturnType<typeof acpHarness>, threadId: string, text: string) {
  h.command({
    type: "thread.send",
    threadId: ThreadId.parse(threadId),
    input: [{ type: "text", text }],
    delivery: "queue",
  });
  await h.engine.flush();
}
async function acpThread(h: ReturnType<typeof acpHarness>, identity: typeof agentA) {
  const existing = new Set(h.store.listThreads().map((thread) => thread.id));
  h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "acp",
    ...identity,
    input: [{ type: "text", text: "ACP source context" }],
  });
  await h.engine.flush();
  const source = h.store.listThreads().find((thread) => !existing.has(thread.id));
  if (source?.provider !== "acp") throw new Error("No ACP source");
  return source.id;
}

test("a thread moves to a registered ACP agent and continues there with the conversation", async () => {
  const h = acpHarness();
  const id = await h.create();
  expect(
    h.command({ type: "thread.switch", threadId: id, selection: { provider: "acp", ...agentA } }),
  ).toMatchObject({ ok: true });
  await h.engine.flush();
  await send(h, id, "follow up");
  expect(h.sessions.at(-1)?.context.acpIdentity).toEqual(agentA);
  expect(h.inputs.at(-1)?.provider).toBe("acp");
  expect(h.inputs.at(-1)?.text).toContain(`source_thread="${id}"`);
  expect(h.inputs.at(-1)?.text.endsWith("follow up")).toBe(true);
  expect(h.store.getThread(id)).toMatchObject({ provider: "acp", ...agentA });
  expect(h.store.getThread(id)?.switch).toMatchObject({ state: "applied", lossy: true });
});

test("an ACP thread changes agent, and returning resumes the first agent's own session", async () => {
  const h = acpHarness();
  const id = await acpThread(h, agentA);
  const first = h.sessions.at(-1)?.nativeId;
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "acp", ...agentB } });
  await h.engine.flush();
  await send(h, id, "work on the second agent");
  expect(h.sessions.at(-1)?.context.acpIdentity).toEqual(agentB);
  expect(h.inputs.at(-1)?.nativeId).not.toBe(first);
  expect(h.inputs.at(-1)?.text).toContain(`source_thread="${id}"`);
  h.command({ type: "thread.switch", threadId: id, selection: { provider: "acp", ...agentA } });
  await h.engine.flush();
  await send(h, id, "back on the first agent");
  expect(h.sessions.at(-1)?.context).toMatchObject({
    acpIdentity: agentA,
    resume: { nativeSessionId: first },
  });
  expect(h.inputs.at(-1)?.text).toMatch(
    /^<ace_context_handoff [^>]*>\nContext handoff\. You are resuming/,
  );
  expect(h.inputs.at(-1)?.text).toContain("work on the second agent");
  expect(h.store.getThread(id)).toMatchObject(agentA);
});

test("a switch to an ACP agent ace hasn't registered, or one it doesn't name, is refused", async () => {
  const h = acpHarness();
  const id = await h.create();
  expect(
    h.command({
      type: "thread.switch",
      threadId: id,
      selection: { provider: "acp", ...agentA, acpAgentId: "unknown-agent" },
    }),
  ).toMatchObject({ ok: false, error: "provider_unavailable" });
  const acp = await acpThread(h, agentA);
  expect(
    h.command({
      type: "thread.switch",
      threadId: acp,
      selection: { provider: "acp", instanceId: agentB.instanceId },
    }),
  ).toMatchObject({ ok: false, error: "acp_identity_required" });
});

test("a usage-limit move keeps an ACP thread on its agent's login", async () => {
  const h = acpHarness();
  const id = await acpThread(h, agentA);
  const original = h.sessions.at(-1)?.nativeId;
  expect(
    h.command({
      type: "thread.limit",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      action: "migrate_now",
    }),
  ).toMatchObject({ ok: false, error: "acp_account_fixed" });
  await h.engine.flush();
  await send(h, id, "follow up");
  expect(h.sessions.at(-1)?.context.acpIdentity).toEqual(agentA);
  expect(h.inputs.at(-1)).toMatchObject({ nativeId: original, text: "follow up" });
});
