import { expect, test } from "vitest";
import { unavailablePickerModel } from "./model-availability.ts";
import { pickerGroups, pickerSection } from "./model-groups.ts";
import type { PickerModel } from "./model-picker.ts";

const local: PickerModel = {
  key: "opencode\u0000lmstudio/qwen3",
  provider: "opencode",
  label: "Qwen3",
  isNew: false,
  legacy: false,
  isDefault: false,
  source: { kind: "local", id: "lmstudio", label: "LM Studio" },
};

test("a saved model the catalog no longer lists leads the list, disabled", () => {
  const vanished = unavailablePickerModel({ provider: "opencode", model: "opencode-go/muse" });
  const groups = pickerGroups([local, vanished], [], "opencode");
  expect(groups.map((group) => group.current.map((model) => model.label))).toEqual([
    [vanished.label],
    ["Qwen3"],
  ]);
  expect(groups[0]?.current[0]?.unavailable).toBe("Unavailable");
});

const zenModel: PickerModel = {
  key: "opencode\u0000opencode/big-pickle",
  provider: "opencode",
  label: "Big Pickle",
  isNew: false,
  legacy: false,
  instance: "opencode",
  source: { kind: "api_key", id: "opencode", label: "OpenCode Zen", service: "opencode_zen" },
};
const oldZenModel: PickerModel = {
  ...zenModel,
  key: `${zenModel.key}-1`,
  label: "Old Pickle",
  legacy: true,
};
const oldLocal: PickerModel = { ...local, key: `${local.key}-old`, label: "Qwen2", legacy: true };
const unreachable = (instance: string) => ({
  provider: "opencode" as const,
  instance,
  stale: true,
  refreshing: false,
  sources: [
    {
      source: { kind: "api_key" as const, id: "openrouter", label: "OpenRouter" },
      status: "stale" as const,
      error: {
        code: "unreachable" as const,
        message: "OpenRouter could not be reached.",
        hint: "Check your network and refresh models.",
      },
    },
  ],
});

test("a provider's sources list as one section with one legacy part and no source headers", () => {
  const section = pickerSection(
    pickerGroups([zenModel, oldZenModel, local, oldLocal], [], "opencode"),
  );
  expect(section?.label).toBeUndefined();
  expect(section?.current.map((model) => model.label)).toEqual(["Qwen3", "Big Pickle"]);
  expect(section?.legacy.map((model) => model.label)).toEqual(["Qwen2", "Old Pickle"]);
});

test("one failing source says nothing while the others still list models", () => {
  const section = pickerSection(
    pickerGroups([zenModel, local], [unreachable("opencode")], "opencode"),
  );
  expect(section?.current.map((model) => model.label)).toEqual(["Qwen3", "Big Pickle"]);
  expect(section?.problems).toEqual([]);
});

test("a problem with the whole account shows beside the models it can't run", () => {
  const expired = {
    provider: "opencode" as const,
    instance: "opencode",
    stale: true,
    refreshing: false,
    errorDetail: {
      code: "auth_expired" as const,
      message: "OpenCode sign-in has expired.",
      hint: "Sign in again.",
    },
  };
  const section = pickerSection(pickerGroups([zenModel], [expired], "opencode"));
  expect(section?.current.map((model) => model.label)).toEqual(["Big Pickle"]);
  expect(section?.problems.map((problem) => problem.message)).toEqual([
    "OpenCode sign-in has expired.",
  ]);
});

test("a tab with nothing listed says why", () => {
  const section = pickerSection(pickerGroups([], [unreachable("opencode")], "opencode"));
  expect(section?.current).toEqual([]);
  expect(section?.problems.map((problem) => problem.message)).toEqual([
    "OpenRouter could not be reached.",
  ]);
});
