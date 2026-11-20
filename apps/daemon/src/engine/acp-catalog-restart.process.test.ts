import { afterEach, expect, test } from "vitest";
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
