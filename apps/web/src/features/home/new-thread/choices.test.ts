import { expect, test } from "vitest";
import { modelKey, type AccountOption, type ModelOption } from "@ace/ui-core";
import { completePreparationChoices, resolve, type NewThreadOptions } from "./choices.ts";

const account = (id: string, provider: "codex" | "opencode"): AccountOption => ({
  id,
  provider,
  label: id,
  usage: "no usage reported",
  isDefault: true,
});

const option = (
  key: string,
  provider: "codex" | "opencode",
  id: string,
  accountId: string,
  efforts: string[],
  defaultEffort: string | undefined,
): ModelOption => ({
  key,
  id,
  account: accountId,
  scope: { provider, instance: accountId },
  label: id,
  provider,
  isDefault: true,
  efforts,
  defaultEffort,
  isNew: false,
  legacy: false,
  speeds: [],
  defaultSpeed: "standard",
});

const codexKey = modelKey("codex", "gpt-6");
const mseKey = modelKey("opencode", "opencode-go/muse-spark-1.3-contributor");

function options(): NewThreadOptions {
  return {
    models: [
      option(
        codexKey,
        "codex",
        "gpt-6",
        "codex-personal",
        ["low", "medium", "high", "xhigh", "max", "ultra"],
        "high",
      ),
      option(
        mseKey,
        "opencode",
        "opencode-go/muse-spark-1.3-contributor",
        "opencode",
        ["low", "medium", "high", "xhigh"],
        "medium",
      ),
    ],
    accounts: [account("codex-personal", "codex"), account("opencode", "opencode")],
  };
}

test("a stored effort from another provider doesn't carry over, even when the level name matches", () => {
  const resolved = resolve(
    options(),
    { model: codexKey, account: "codex-personal", effort: "xhigh" },
    "opencode",
    "local",
  );
  expect(resolved.provider).toBe("opencode");
  expect(resolved.model?.key).toBe(mseKey);
  // XHigh exists on both, but the stored pick belonged to Codex: start at mse's default.
  expect(resolved.effort).toBe("medium");
});

test("a stored level the new model doesn't offer falls back to its default", () => {
  const resolved = resolve(
    options(),
    { model: codexKey, account: "codex-personal", effort: "ultra" },
    "opencode",
    "local",
  );
  expect(resolved.effort).toBe("medium");
});

test("a stored effort for the resolved model is kept", () => {
  const resolved = resolve(
    options(),
    { model: mseKey, account: "opencode", effort: "xhigh" },
    "opencode",
    "local",
  );
  expect(resolved.model?.key).toBe(mseKey);
  expect(resolved.effort).toBe("xhigh");
});

test("completing a preparation keeps an effort chosen for its own model", () => {
  const resolved = resolve(
    options(),
    { model: mseKey, account: "opencode", effort: "xhigh" },
    "opencode",
    "local",
  );
  // The write path keeps the model's own pair together; `resolve` above is what resets
  // stale thinking when the draft resolves to another model.
  const completed = completePreparationChoices(
    { model: mseKey, account: "opencode", effort: "xhigh" },
    resolved,
  );
  expect(completed.model).toBe(mseKey);
  expect(completed.effort).toBe("xhigh");
});
