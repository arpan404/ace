import { afterEach, expect, test } from "vitest";
import type { TransitionIO } from "./transitions.ts";
import { transitionHarness } from "./transition-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
// The provider can't copy native history between these accounts (a normal CLI login, say).
const uncopyable: TransitionIO = {
  applyPatch: async () => {},
  migrate: async () => ({
    status: "unsupported",
    reason: "Normal CLI logins can't share native history",
  }),
};
function setup(io: TransitionIO = uncopyable) {
  const h = transitionHarness({ io });
  cleanup.push(h.close);
  return h;
}
type Harness = ReturnType<typeof setup>;
async function send(h: Harness, threadId: Awaited<ReturnType<Harness["create"]>>, text: string) {
  expect(
    h.command({ type: "thread.send", threadId, input: [{ type: "text", text }], delivery: "queue" })
      .ok,
  ).toBe(true);
  await h.engine.flush();
}
async function moveTo(
  h: Harness,
  threadId: Awaited<ReturnType<Harness["create"]>>,
  account: string,
) {
  expect(
    h.command({
      type: "thread.switch",
      threadId,
      selection: { provider: "codex", instanceId: account },
    }).ok,
  ).toBe(true);
  await h.engine.flush();
}

test("an account change the provider can't copy continues on a fresh session with the conversation", async () => {
  const h = setup();
  const id = await h.create();
  const original = h.sessions[0]?.nativeId;
  await moveTo(h, id, "account-b");
  await send(h, id, "follow up");
  expect(h.sessions.at(-1)?.context).toMatchObject({ instanceId: "account-b" });
  expect(h.sessions.at(-1)?.context.resume).toBeUndefined();
  const delivered = h.inputs.at(-1);
  expect(delivered?.nativeId).not.toBe(original);
  expect(delivered?.text).toContain(`source_thread="${id}"`);
  expect(delivered?.text).toContain("user: source history");
  expect(delivered?.text.endsWith("follow up")).toBe(true);
  expect(h.store.getThread(id)?.switch).toMatchObject({ state: "applied", lossy: true });
  expect(Object.values(h.store.snapshotThread(id).items)).toContainEqual(
    expect.objectContaining({
      type: "message",
      origin: expect.objectContaining({
        kind: "handoff",
        to: expect.objectContaining({ provider: "codex" }),
        lossy: true,
      }),
    }),
  );
});

test("returning to an account resumes the session it left there with only what happened since", async () => {
  const h = setup();
  const id = await h.create();
  const original = h.sessions[0]?.nativeId;
  await moveTo(h, id, "account-b");
  await send(h, id, "work done on b");
  await moveTo(h, id, "account-a");
  await send(h, id, "back on a");
  expect(h.sessions.at(-1)?.context).toMatchObject({
    instanceId: "account-a",
    resume: { nativeSessionId: original },
  });
  const delivered = h.inputs.at(-1);
  expect(delivered?.nativeId).toBe(original);
  // The resumed session already holds the opening ask; the handoff is only what happened since.
  expect(delivered?.text).toMatch(
    /^<ace_context_handoff [^>]*>\nContext handoff\. You are resuming/,
  );
  expect(delivered?.text).toMatch(/\n--- item [^\n]*\nuser: work done on b\n/);
  expect(delivered?.text.endsWith("back on a")).toBe(true);
});

test("a second account change before delivery replaces the waiting handoff instead of stacking it", async () => {
  const h = setup();
  const id = await h.create();
  await moveTo(h, id, "account-b");
  await moveTo(h, id, "account-c");
  await send(h, id, "follow up");
  expect(h.sessions.at(-1)?.context).toMatchObject({ instanceId: "account-c" });
  const handoffs = Object.values(h.store.snapshotThread(id).items).filter(
    (item) => item.type === "message" && item.origin?.kind === "handoff",
  );
  expect(handoffs).toHaveLength(1);
  expect(h.inputs.at(-1)?.text.split("source_thread=")).toHaveLength(2);
});

test("a destination account that can't take the thread fails the switch and keeps the source session", async () => {
  const h = setup({ ...uncopyable, accountProblem: () => "That account is signed out" });
  const id = await h.create();
  const original = h.sessions[0]?.nativeId;
  await moveTo(h, id, "account-b");
  expect(h.store.getThread(id)?.switch).toMatchObject({
    state: "failed",
    error: "That account is signed out",
  });
  await send(h, id, "follow up");
  expect(h.sessions.at(-1)?.context.instanceId).not.toBe("account-b");
  expect(h.inputs.at(-1)).toMatchObject({ nativeId: original, text: "follow up" });
});

test("a copy the accounts service makes resumes natively and keeps the full session", async () => {
  const h = setup({
    applyPatch: async () => {},
    migrate: async (request) => ({
      status: "migrated",
      nativeSessionId: request.nativeSessionId,
      action: "resume",
      copiedFiles: 1,
    }),
  });
  const id = await h.create();
  const original = h.sessions[0]?.nativeId;
  await moveTo(h, id, "account-b");
  await send(h, id, "follow up");
  expect(h.sessions.at(-1)?.context).toMatchObject({
    instanceId: "account-b",
    resume: { nativeSessionId: original },
  });
  expect(h.inputs.at(-1)).toMatchObject({ nativeId: original, text: "follow up" });
  expect(h.store.getThread(id)?.switch).toMatchObject({ state: "applied", lossy: false });
});
