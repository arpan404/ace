import { afterEach, expect, test } from "vitest";
import { antigravityQuirks } from "@ace/adapter-acp";
import { ModelCatalog } from "@ace/models";
import { scriptedModelInstance, seedScriptedModels } from "../testing/models.ts";
import { cleanupRecovery, dispatch, fixture, restart, text } from "./recovery-test-support.ts";
import { end, scriptFrames, start } from "./test-support.ts";
afterEach(cleanupRecovery);

const identity = {
  acpAgentId: "test-agent",
  installationId: "test-install",
  instanceId: "test-instance",
};
const catalog = () =>
  new ModelCatalog({
    storage: { load: () => [], replace() {}, remove() {}, close() {} },
    discover: async () => {
      throw new Error("Generic ACP never discovers");
    },
    now: () => 1000,
    deadline: () => () => {},
  });

test("a generic ACP thread's chosen model opens after a restart, before its agent's catalog row was registered", async () => {
  const frames = scriptFrames();
  const turn = { on: "send" as const, frames: [frames.frame(start, end)] };
  const before = catalog();
  const h = await fixture([turn, { on: "close" }, turn], frames, {
    provider: "acp",
    models: before,
  });
  const row = { ...scriptedModelInstance("acp", h.home, "acp-test-row"), ...identity };
  await seedScriptedModels(before, row, "model");
  const id = await h.create();
  // After the restart nothing has registered the agent's row: only the hook that runs before
  // the model is chosen does.
  const after = catalog();
  let registered = 0;
  const engine = await restart(h, {
    models: after,
    sessionCatalog: async () => {
      registered++;
      await seedScriptedModels(after, row, "model");
    },
  });
  dispatch(h.store, engine, { type: "thread.send", threadId: id, input: text("again") }, "again");
  await engine.flush();
  expect(engine.queue(id)).toMatchObject({ paused: false, pendingCount: 0 });
  expect(h.contexts.at(-1)?.model).toBe("model");
  expect(registered).toBe(1);
});

test("an effort Antigravity didn't take leaves the thread, which says it runs at the default", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, end)] }], frames, {
    provider: "antigravity",
    capabilities: antigravityQuirks.capabilities("1.2.1"),
    // Full access is the one mode Antigravity offers.
    permissionSettings: async () => ({ access: "full-access" as const }),
  });
  const original = h.registry.get("antigravity").adapter;
  h.registry.register(
    {
      ...original,
      async openSession(context) {
        const session = await original.openSession(context);
        return Object.assign(session, { refusedOptions: ["effort"] });
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const created = h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "antigravity",
    model: "model",
    options: { effort: "max" },
    input: text("first"),
  });
  if (!created.ok || !created.threadId) throw new Error(created.error);
  await h.engine.flush();
  expect(h.store.getThread(created.threadId)?.live?.options ?? {}).not.toHaveProperty("effort");
  const notices = Object.values(h.store.snapshotThread(created.threadId).items).filter(
    (item) => item.type === "notice" && item.code === "execution_option_refused",
  );
  expect(notices).toMatchObject([
    { text: "This agent didn't take the max thinking level, so it runs at its default." },
  ]);
});
