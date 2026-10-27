import type { ProviderConfigurations } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { changeProvider } from "./model-favorites.ts";
import {
  binaryPathChange,
  checkpointChange,
  customModelChange,
  editProviderConfiguration,
  modelVisibilityChange,
  type ConfigurationClient,
} from "./provider-configuration-edit.ts";

/** A daemon's settings store: reads see what the last write saved. */
function settingsStore(initial: ProviderConfigurations) {
  let saved = initial;
  const client = {
    request: async (message: { type: string; value?: unknown }) => {
      await Promise.resolve();
      if (message.type === "settings.get") return { ok: true, entries: [{ value: saved }] };
      saved = message.value as ProviderConfigurations;
      return { ok: true };
    },
  } as unknown as ConfigurationClient;
  return {
    client,
    saved: () => saved,
    elsewhere: (rows: ProviderConfigurations) => {
      saved = rows;
    },
  };
}

describe("provider preferences", () => {
  it("keeps a field another device saved between two edits from this one", async () => {
    const store = settingsStore([{ provider: "codex", favourites: ["gpt-6"] }]);
    store.elsewhere([{ provider: "codex", favourites: ["gpt-6"], defaultModel: "gpt-6" }]);
    await editProviderConfiguration(store.client, (rows) =>
      changeProvider(rows, "codex", (row) => ({ ...row, enabled: false })),
    );
    expect(store.saved()).toEqual([
      { provider: "codex", favourites: ["gpt-6"], defaultModel: "gpt-6", enabled: false },
    ]);
  });

  it("applies two edits made at once one after the other, losing neither", async () => {
    const store = settingsStore([]);
    await Promise.all([
      editProviderConfiguration(store.client, (rows) =>
        changeProvider(rows, "cursor", (row) => ({ ...row, maxCheckpointMb: 64 })),
      ),
      editProviderConfiguration(store.client, (rows) =>
        changeProvider(rows, "cursor", (row) => ({ ...row, enabled: false })),
      ),
    ]);
    expect(store.saved()).toEqual([{ provider: "cursor", maxCheckpointMb: 64, enabled: false }]);
  });

  it("refuses a relative CLI path and clears the path when emptied", () => {
    expect(binaryPathChange("bin/codex")).toMatchObject({ ok: false });
    const set = binaryPathChange("  /opt/homebrew/bin/codex ");
    const cleared = binaryPathChange("");
    if (!set.ok || !cleared.ok) throw new Error("expected valid changes");
    expect(set.change({ provider: "codex" })).toEqual({
      provider: "codex",
      binaryPath: "/opt/homebrew/bin/codex",
    });
    expect(cleared.change({ provider: "codex", binaryPath: "/x" })).toEqual({ provider: "codex" });
  });

  it("takes a checkpoint budget from 1 to 256 whole megabytes only", () => {
    for (const typed of ["0", "257", "1.5", "lots"])
      expect(checkpointChange(typed)).toMatchObject({ ok: false });
    const set = checkpointChange("128");
    if (!set.ok) throw new Error("expected a valid change");
    expect(set.change({ provider: "cursor" })).toEqual({
      provider: "cursor",
      maxCheckpointMb: 128,
    });
  });

  it("shows a hidden model again under every alias it was hidden by", () => {
    const show = modelVisibilityChange({ id: "sonnet", aliases: ["claude-sonnet"] }, true);
    expect(
      show({ provider: "claude", hiddenModels: ["claude-sonnet", "opus"], shownModels: [] }),
    ).toEqual({ provider: "claude", hiddenModels: ["opus"], shownModels: ["sonnet"] });
  });

  it("refuses a custom model whose id is already added", () => {
    const row = { provider: "pi" as const, customModels: [{ id: "x", displayName: "X" }] };
    expect(customModelChange(row, "x", "Again")).toMatchObject({ ok: false });
    expect(customModelChange(row, "y", " ")).toMatchObject({ ok: false });
    const added = customModelChange(row, " y ", "Y model");
    if (!added.ok) throw new Error("expected a valid change");
    expect(added.change(row).customModels).toEqual([
      { id: "x", displayName: "X" },
      { id: "y", displayName: "Y model" },
    ]);
  });
});
