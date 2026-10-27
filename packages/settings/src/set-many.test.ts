import { afterEach, expect, test } from "vitest";
import type { Notification } from "./index.ts";
import { fixture } from "./test-support.ts";

/*
 * `setMany`: several settings on one layer, all or none, seen by subscribers as one change.
 * A role change (model, provider, effort) must never land half-written.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup() {
  const f = await fixture();
  cleanups.push(() => f.close());
  return f;
}
const role = [
  "providers.coder.provider",
  "providers.coder.model",
  "providers.coder.reasoningEffort",
] as const;

test("a batch with one value the setting won't take writes none of it", async () => {
  const f = await setup();
  await expect(
    f.service.setMany(
      [
        { key: "providers.coder.model", value: "claude-opus-5-5" },
        { key: "providers.coder.provider", value: "claude" },
        { key: "providers.coder.reasoningEffort", value: "enormous" },
      ],
      { kind: "global" },
    ),
  ).rejects.toThrow();
  for (const key of role) expect((await f.service.get(key, {})).provenance, key).toBe("defaults");
});

test("a batch on a layer one of its settings can't live on writes none of it", async () => {
  const f = await setup();
  await expect(
    f.service.setMany(
      [
        { key: "threads.unresponsiveAfter", value: "2m" },
        { key: "providers.coder.provider", value: "claude" },
      ],
      { kind: "workspace", workspace: f.workspace },
    ),
  ).rejects.toThrow("Roles are a global setting");
  expect(
    (await f.service.get("threads.unresponsiveAfter", { workspace: f.workspace })).provenance,
  ).toBe("defaults");
});

test("a batch is written together and subscribers see it as one change", async () => {
  const f = await setup();
  const seen: Notification[] = [];
  const stop = await f.service.subscribe({ keys: [...role], scope: {} }, (event) =>
    seen.push(event),
  );
  await f.service.setMany(
    [
      { key: "providers.coder.model", value: "claude-opus-5-5" },
      { key: "providers.coder.provider", value: "claude" },
      { key: "providers.coder.reasoningEffort", value: "high" },
    ],
    { kind: "global" },
  );
  await f.service.settled({ kind: "global" });
  stop();
  const changes = seen.filter((event) => event.type === "changed");
  expect(changes).toHaveLength(1);
  expect(
    changes[0]?.type === "changed" && changes[0].entries.map((entry) => entry.key).toSorted(),
  ).toEqual([...role].toSorted());
  expect(await f.service.get("providers.coder.reasoningEffort", {})).toMatchObject({
    value: "high",
    provenance: "global",
  });
});
