import { expect, test } from "vitest";
import { CatalogModel } from "@ace/protocol";
import { configuredModels, providerConfiguration } from "@ace/models/preferences";

const row = CatalogModel.parse({
  id: "anthropic/claude-opus-4-8",
  nativeModelId: "claude-opus-4-8",
  nativeProviderId: "anthropic",
  provider: "opencode",
  instance: "work",
  displayName: "Claude Opus 4.8",
  reasoningEfforts: [],
  serviceTiers: [],
  inputModalities: [],
  isDefault: true,
  hidden: false,
  deprecated: true,
  raw: { json: "{}", truncated: false },
});
const result = (config: Parameters<typeof configuredModels>[3]) =>
  configuredModels([row], "opencode", "work", config)[0];

test("deprecated choices hide by default and explicit show permits selection", () => {
  expect(result({ provider: "opencode" })).toMatchObject({
    hidden: true,
    visibilityReason: "deprecated",
  });
  expect(result({ provider: "opencode", shownModels: [row.id] })).toMatchObject({ hidden: false });
  expect(result({ provider: "opencode", hideDeprecated: false })).toMatchObject({ hidden: false });
});
test("hiding an upstream group takes precedence over an individual show until the group is shown", () => {
  expect(
    result({ provider: "opencode", hiddenGroups: ["anthropic"], shownModels: [row.id] }),
  ).toMatchObject({ hidden: true, visibilityReason: "group_hidden" });
  expect(
    result({
      provider: "opencode",
      hiddenGroups: ["anthropic"],
      shownGroups: ["anthropic"],
      shownModels: [row.id],
    }),
  ).toMatchObject({ hidden: false });
});
test("a disabled provider cannot be enabled by an account override", () => {
  expect(
    providerConfiguration(
      [
        { provider: "opencode", enabled: false },
        { provider: "opencode", instance: "work", enabled: true },
      ],
      "opencode",
      "work",
    ).enabled,
  ).toBe(false);
});
test("a custom id cannot overwrite provider capabilities or the provider's display name", () => {
  const rows = configuredModels([row], "opencode", "work", {
    provider: "opencode",
    customModels: [{ id: row.id, displayName: "Wrong name" }],
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.displayName).toBe("Claude Opus 4.8");
});
