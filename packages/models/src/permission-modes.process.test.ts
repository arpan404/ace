import { join } from "node:path";
import { expect, test } from "vitest";
import { ModelCatalog, openModelStorage } from "./index.ts";
import { Clock, instance, workspace } from "./testing/support.ts";

test("an ACP instance advertises its native labels and retains them after restart", async () => {
  const work = await workspace();
  const clock = new Clock();
  const path = join(work.path, "models.sqlite");
  const one = instance("acp", "one"),
    two = instance("acp", "two");
  const open = () =>
    new ModelCatalog({
      instances: [one, two],
      storage: openModelStorage(path),
      discover: async () => {
        throw new Error("A catalog read must not launch an agent");
      },
      now: () => clock.now,
      deadline: clock.deadline,
    });
  let catalog = open();
  try {
    await catalog.updateFromSession(one, {
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "native-model",
          options: [{ value: "native-model", name: "Native model" }],
        },
        {
          id: "permission-selector",
          category: "permissions",
          type: "select",
          currentValue: "manual-native",
          options: [
            { value: "manual-native", name: "Manual from agent", description: "Agent asks" },
            { value: "read-only", name: "Inspect from agent", description: "Agent inspects" },
          ],
        },
      ],
    });
    const expected = [
      {
        id: "manual-native",
        label: "Manual from agent",
        description: "Agent asks",
        risk: "medium",
      },
      {
        id: "read-only",
        label: "Inspect from agent",
        description: "Agent inspects",
        risk: "medium",
      },
    ];
    expect(catalog.list({ instance: "one" }).instances[0]?.permissionModes).toEqual(expected);
    expect(catalog.list({ instance: "two" }).instances[0]?.permissionModes).toEqual([]);
    await catalog.close();
    catalog = open();
    expect(catalog.list({ instance: "one" }).instances[0]?.permissionModes).toEqual(expected);
    expect(catalog.list({ instance: "two" }).instances[0]?.permissionModes).toEqual([]);
  } finally {
    await catalog.close();
    await work.close();
  }
});
