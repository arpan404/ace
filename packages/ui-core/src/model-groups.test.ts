import { expect, test } from "vitest";
import { unavailablePickerModel } from "./model-availability.ts";
import { pickerGroups } from "./model-groups.ts";
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
