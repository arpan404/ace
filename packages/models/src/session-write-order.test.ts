import { expect, test } from "vitest";
import type { NativePermissionMode } from "@ace/protocol";
import { ModelCatalog } from "./index.ts";
import { Clock, instance } from "./testing/support.ts";

/** A catalog over in-memory storage, reopened from what it last stored. */
function memoryCatalog() {
  const clock = new Clock();
  const one = instance("acp", "one");
  let stored: unknown[] = [];
  const open = () =>
    new ModelCatalog({
      instances: [one],
      storage: {
        load: () => structuredClone(stored) as never,
        async replace(entry) {
          await Promise.resolve();
          stored = [structuredClone(entry)];
        },
        remove() {},
        close() {},
      },
      discover: async () => {
        throw new Error("A catalog read must not launch an agent");
      },
      now: () => clock.now,
      deadline: clock.deadline,
    });
  return { one, open };
}

/** A session's setup: both models listed, levels only for the model it runs. */
function running(model: "fast" | "deep") {
  const levels = model === "fast" ? ["low", "high"] : ["low", "high", "max"];
  return {
    configOptions: [
      {
        id: "model",
        category: "model",
        type: "select",
        currentValue: model,
        options: [
          { value: "fast", name: "Fast" },
          { value: "deep", name: "Deep" },
        ],
      },
      {
        id: "thinking",
        category: "thought_level",
        type: "select",
        currentValue: "low",
        options: levels.map((value) => ({ value, name: value })),
      },
    ],
  };
}

const efforts = (catalog: ModelCatalog, model: string) =>
  catalog
    .list({ instance: "one" })
    .models.find((entry) => entry.id === model)
    ?.efforts.map((effort) => effort.id);

test("two sessions reporting different models at once keep both models' thinking levels", async () => {
  const { one, open } = memoryCatalog();
  let catalog = open();
  try {
    await Promise.all([
      catalog.updateFromSession(one, running("fast")),
      catalog.updateFromSession(one, running("deep")),
    ]);
    expect(efforts(catalog, "fast")).toEqual(["low", "high"]);
    expect(efforts(catalog, "deep")).toEqual(["low", "high", "max"]);
    await catalog.close();
    catalog = open();
    expect(efforts(catalog, "fast")).toEqual(["low", "high"]);
  } finally {
    await catalog.close();
  }
});

const mode = (id: string): NativePermissionMode => ({
  id,
  label: id,
  description: "",
  risk: "medium",
});

test("modes reported A, then B, then A again are stored as A", async () => {
  const { one, open } = memoryCatalog();
  let catalog = open();
  try {
    await catalog.updateFromSession(one, {
      ...running("fast"),
      modes: { availableModes: [{ id: "plan", name: "plan" }] },
    });
    const reported = catalog.list({ instance: "one" }).instances[0]?.permissionModes;
    expect(reported).toEqual([mode("plan")]);
    catalog.updatePermissionModes("one", [mode("yolo")]);
    catalog.updatePermissionModes("one", [mode("plan")]);
    await catalog.close();
    catalog = open();
    expect(
      catalog.list({ instance: "one" }).instances[0]?.permissionModes?.map((entry) => entry.id),
    ).toEqual(["plan"]);
  } finally {
    await catalog.close();
  }
});
