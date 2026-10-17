import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ModelCatalog, normalizeCodex, openModelStorage } from "./index.ts";
import { Clock, codexPayload, instance, workspace } from "./testing/support.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

test("a CLI older than ace's minimum lists no models and says which update it needs; updating clears it", async () => {
  const work = await workspace();
  cleanup.push(work.close);
  const clock = new Clock();
  let probes = 0;
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(work.path, "models.sqlite")),
    instances: [{ ...instance("codex"), cwd: work.path, installationVersion: "0.158.0" }],
    discover: async (config) => {
      probes++;
      return normalizeCodex(codexPayload(), config);
    },
    now: () => clock.now,
    deadline: clock.deadline,
    random: () => 0.5,
  });
  cleanup.push(() => catalog.close());
  await catalog.refresh();
  expect(probes).toBe(0);
  expect(catalog.list().instances[0]?.errorDetail).toEqual({
    code: "cli_too_old",
    message: "Codex 0.158.0 is older than 0.159.1, the oldest version ace supports.",
    hint: "Update Codex, then refresh models.",
  });
  catalog.installationChanged("codex", "0.159.1");
  await catalog.refresh();
  expect(probes).toBeGreaterThan(0);
  expect(catalog.list().models[0]?.id).toBe("coder");
  expect(catalog.list().instances[0]?.errorDetail).toBeUndefined();
});
