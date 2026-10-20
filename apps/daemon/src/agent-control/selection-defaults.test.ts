import { expect, it } from "vitest";
import { CatalogModel, type ModelListOptions, type ProviderKind } from "@ace/protocol";
import { scriptedEfforts } from "../testing/models.ts";
import { resolveSelection } from "./selection-defaults.ts";

function model(provider: ProviderKind, id: string, acp?: Record<string, string>) {
  return CatalogModel.parse({
    id,
    nativeModelId: id,
    displayName: id,
    provider,
    instance: `${provider}-default`,
    efforts: scriptedEfforts,
    serviceTiers: [],
    inputModalities: [],
    isDefault: false,
    hidden: false,
    deprecated: false,
    raw: { json: "{}", truncated: false },
    ...acp,
  });
}
/** A catalogue as the daemon pages it: filtered by provider, 100 per page. */
function catalogue(models: CatalogModel[]) {
  return (options: ModelListOptions) => ({
    models: models.filter((entry) => !options.provider || entry.provider === options.provider),
    instances: [],
  });
}

it("a task that names neither provider nor model runs on the caller's provider", () => {
  expect(resolveSelection({}, "codex", catalogue([])).provider).toBe("codex");
});

it("a model only another provider serves selects that provider", () => {
  const list = catalogue([model("codex", "gpt-6"), model("claude", "opus-5")]);
  expect(resolveSelection({ model: "opus-5" }, "codex", list).provider).toBe("claude");
  // The caller's provider wins when it serves the model too, and an unknown model stays home.
  const shared = catalogue([model("codex", "shared"), model("claude", "shared")]);
  expect(resolveSelection({ model: "shared" }, "codex", shared).provider).toBe("codex");
  expect(resolveSelection({ model: "unknown" }, "codex", list).provider).toBe("codex");
});

it("an ACP model resolves the agent, installation and instance that serve it", () => {
  const list = catalogue([
    model("acp", "gemini-3", {
      acpAgentId: "gemini",
      installationId: "gemini-install",
      instanceId: "gemini-instance",
    }),
  ]);
  expect(resolveSelection({ model: "gemini-3" }, "claude", list)).toMatchObject({
    provider: "acp",
    acpAgentId: "gemini",
    installationId: "gemini-install",
    instanceId: "gemini-instance",
  });
});
