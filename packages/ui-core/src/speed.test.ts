import type { CatalogModel } from "@ace/protocol";
import { expect, test } from "vitest";
import { modelControlName } from "./model-picker.ts";
import { defaultSpeed, speedControl, speedOption, speedTiers } from "./speed.ts";

type ModelTier = CatalogModel["serviceTiers"][number];

/** A catalog tier; `null` for one set some other way than a `serviceTier` option. */
const tier = (id: string, speed: ModelTier["speed"], serviceTier: string | null = id) => ({
  id,
  name: id,
  ...(speed ? { speed } : {}),
  parameters: serviceTier === null ? {} : { serviceTier },
});
const codex = (serviceTiers: ModelTier[], defaultTier?: string) => {
  const model = { serviceTiers, defaultTier };
  return {
    label: "GPT-5",
    provider: "codex" as const,
    speeds: speedTiers(model),
    defaultSpeed: defaultSpeed(model),
  };
};

test("the speed control offers only the catalog's tiers, slowest first", () => {
  const model = codex([tier("ultra", "ultrafast"), tier("priority", "fast")]);
  expect(model.speeds.map((entry) => entry.speed)).toEqual(["standard", "fast", "ultrafast"]);
  const onlyFast = codex([tier("priority", "fast")]);
  expect(onlyFast.speeds.map((entry) => entry.speed)).toEqual(["standard", "fast"]);
});

test("a speed ace doesn't know yet isn't offered, and the known ones still are", () => {
  const model = codex([tier("priority", "fast"), tier("warp", "hyperfast")]);
  expect(model.speeds.map((entry) => entry.speed)).toEqual(["standard", "fast"]);
});

test("a tier ace can't ask for by service tier isn't offered", () => {
  const model = codex([tier("fast", "fast", null)]);
  const control = speedControl({ model, current: undefined });
  expect(control.tiers).toEqual([]);
  expect(control.reason).toBe("GPT-5 has no faster tier");
});

test("each speed is asked for by its own service tier, and standard by leaving it out", () => {
  const model = codex([tier("priority", "fast"), tier("ultra", "ultrafast")]);
  expect(speedOption(model.speeds, "ultrafast")).toBe("ultra");
  expect(speedControl({ model, current: "ultra" }).speed).toBe("ultrafast");
  expect(speedOption(model.speeds, "standard")).toBeUndefined();
  expect(speedControl({ model, current: undefined }).speed).toBe("standard");
});

test("choosing standard on a model that is standard by default sends no tier, even one it lists", () => {
  const model = codex([tier("default", "standard"), tier("priority", "fast")]);
  expect(speedOption(model.speeds, "standard")).toBeUndefined();
  expect(speedControl({ model, current: undefined }).speed).toBe("standard");
});

test("a model the catalog runs fast by default stays fast until standard is asked for", () => {
  const model = codex([tier("priority", "fast")], "priority");
  expect(speedControl({ model, current: undefined }).speed).toBe("fast");
  expect(speedOption(model.speeds, "standard")).toBe("default");
  expect(speedControl({ model, current: "default" }).speed).toBe("standard");
});

test("speed can change on a running thread only where the provider takes a service tier", () => {
  const model = codex([tier("priority", "fast")]);
  expect(
    speedControl({
      model,
      current: undefined,
      running: true,
      capabilities: { sessionOptions: true, launchOptions: ["effort"] },
    }).reason,
  ).toBe("Codex sets speed only when a thread starts");
  expect(
    speedControl({
      model,
      current: "priority",
      running: true,
      capabilities: { sessionOptions: true, launchOptions: ["serviceTier"] },
    }),
  ).toMatchObject({ speed: "fast", reason: undefined });
});

test("the chip's name says a faster speed and stays quiet about standard", () => {
  const details = { model: "GPT-5", effort: "high", hasEfforts: true };
  expect(modelControlName({ ...details, speed: "ultrafast" })).toBe(
    "GPT-5, High effort, ultrafast",
  );
  expect(modelControlName({ ...details, speed: "standard" })).toBe("GPT-5, High effort");
});
