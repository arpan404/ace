import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { ModelCatalog, normalizeCodex, openModelStorage } from "./index.ts";
import { Clock, codexPayload, instance, workspace } from "./testing/support.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

test("a login changed outside ace shows on the next read, and an unread catalog checks nothing", async () => {
  const work = await workspace();
  cleanup.push(work.close);
  const clock = new Clock();
  let connection = "signed-in-a";
  let model = "coder";
  let checks = 0;
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(work.path, "models.sqlite")),
    instances: [{ ...instance("pi"), cwd: work.path }],
    discover: async (config) => normalizeCodex(codexPayload(model), config),
    revisionProbe: async () => {
      checks++;
      return connection;
    },
    connectionCheckMs: 60_000,
    now: () => clock.now,
    deadline: clock.deadline,
    random: () => 0.5,
  });
  cleanup.push(() => catalog.close());
  await catalog.refresh();
  expect(catalog.list().models.map((entry) => entry.id)).toEqual(["coder"]);
  await pause(20);
  expect(checks).toBe(1);

  // Reads within the interval share that check; time passing without reads starts none.
  catalog.list();
  catalog.resolve({ role: "build" });
  clock.now += 10 * 60_000;
  await pause(20);
  expect(checks).toBe(1);

  // The person signs in to another account in a terminal; the next read notices.
  connection = "signed-in-b";
  model = "other";
  catalog.list();
  for (let i = 0; i < 200 && catalog.list().models[0]?.id !== "other"; i++) await pause(10);
  expect(checks).toBe(2);
  expect(catalog.list().models.map((entry) => entry.id)).toEqual(["other"]);
});
