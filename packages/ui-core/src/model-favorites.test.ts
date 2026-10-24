import { ProviderConfigurations } from "@ace/protocol";
import { expect, test } from "vitest";
import { favoriteModelKeys, withFavoriteToggled } from "./model-favorites.ts";
import { modelKey } from "./models.ts";

// "opus" is the catalog id; "claude-opus" an older name for it.
const canonical = (_provider: string, id: string | null | undefined) =>
  id === "claude-opus" ? "opus" : (id ?? null);

test("a star lands on its provider's own row and reads back as that provider's key", () => {
  const rows = ProviderConfigurations.parse([
    { provider: "codex", instance: "work", favourites: ["gpt-6"] },
  ]);
  const starred = withFavoriteToggled(rows, modelKey("claude", "sonnet"), canonical) ?? [];
  expect(favoriteModelKeys(starred, canonical)).toEqual([modelKey("claude", "sonnet")]);
  // An account's own row keeps its fields and never counts as the provider's stars.
  expect(starred.find((row) => row.instance === "work")?.favourites).toEqual(["gpt-6"]);
});

test("starring again unstars, and a star saved under an old name counts as the model's", () => {
  const rows = ProviderConfigurations.parse([{ provider: "claude", favourites: ["claude-opus"] }]);
  expect(favoriteModelKeys(rows, canonical)).toEqual([modelKey("claude", "opus")]);
  const unstarred = withFavoriteToggled(rows, modelKey("claude", "opus"), canonical) ?? [];
  expect(favoriteModelKeys(unstarred, canonical)).toEqual([]);
});

test("a key that names no provider changes nothing", () => {
  expect(withFavoriteToggled([], "opus", canonical)).toBeUndefined();
});
