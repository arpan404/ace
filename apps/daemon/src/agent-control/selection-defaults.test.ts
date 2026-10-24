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
    models: models.filter(
      (entry) =>
        (!options.provider || entry.provider === options.provider) &&
        (!options.instance || entry.instance === options.instance) &&
        (!options.instanceId || entry.instanceId === options.instanceId),
    ),
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

it("a model named the way a person writes it runs as the catalog model it means", () => {
  const list = catalogue([
    model("claude", "claude-opus-5-5"),
    model("codex", "gpt-6.1-sol"),
    model("pi", "openai-codex/gpt-6.1-sol"),
  ]);
  expect(resolveSelection({ model: "Claude Opus 5.5" }, "codex", list)).toMatchObject({
    provider: "claude",
    model: "claude-opus-5-5",
  });
  // Another provider's catalog is searched when the caller's has nothing near.
  expect(resolveSelection({ model: "gpt 6.1 sol" }, "claude", list)).toMatchObject({
    provider: "codex",
    model: "gpt-6.1-sol",
  });
  // A named provider is searched, never left for another.
  expect(resolveSelection({ provider: "pi", model: "gpt 6.1 sol" }, "claude", list)).toMatchObject({
    provider: "pi",
    model: "openai-codex/gpt-6.1-sol",
  });
});

it("a loose name that fits several models is refused with the ids to choose from", () => {
  const list = catalogue([model("codex", "gpt-6-luna"), model("codex", "gpt-6-astra")]);
  expect(() => resolveSelection({ model: "gpt 6" }, "codex", list)).toThrow(
    expect.objectContaining({
      code: "invalid_arguments",
      publicDetail: expect.stringMatching(/gpt-6-luna.*gpt-6-astra|gpt-6-astra.*gpt-6-luna/),
    }),
  );
});

it("a named provider without the model says which provider has it", () => {
  const list = catalogue([model("codex", "gpt-6.1-sol"), model("claude", "claude-opus-5-5")]);
  expect(() =>
    resolveSelection({ provider: "claude", model: "gpt 6.1 sol" }, "claude", list),
  ).toThrow(
    expect.objectContaining({
      code: "model_unavailable",
      publicDetail: expect.stringContaining("gpt-6.1-sol (codex)"),
    }),
  );
});

it("a hidden model is never what a loose name means", () => {
  const hidden = { ...model("claude", "claude-opus-5-5"), hidden: true };
  const list = catalogue([hidden, model("claude", "claude-opus-4-8")]);
  expect(resolveSelection({ model: "opus" }, "claude", list).model).toBe("claude-opus-4-8");
});

it("a child for another machine keeps its model name for that machine's catalog", () => {
  const list = catalogue([model("claude", "claude-opus-5-5")]);
  expect(resolveSelection({ model: "opus 5.5", machine: "studio" }, "claude", list).model).toBe(
    "opus 5.5",
  );
});

it("a loose name on an ACP account is matched on that account's rows, which also name its agent", () => {
  const approved = {
    ...model("acp", "claude-opus-5-5", {
      acpAgentId: "local:agent",
      installationId: "approved",
      instanceId: "approved:default",
    }),
    // Production keys ACP catalogs by an opaque digest, not by the account id.
    instance: "acp-production-catalog-digest",
    displayName: "Opus 5.5",
  };
  const other = {
    ...model("acp", "claude-opus-5-5-other", {
      acpAgentId: "local:other",
      installationId: "other",
      instanceId: "other:default",
    }),
    instance: "acp-other-digest",
    displayName: "Opus 5.5",
  };
  const list = catalogue([other, approved]);
  expect(
    resolveSelection(
      { provider: "acp", accountId: "approved:default", model: "opus 5.5" },
      "claude",
      list,
    ),
  ).toMatchObject({
    model: "claude-opus-5-5",
    acpAgentId: "local:agent",
    installationId: "approved",
    instanceId: "approved:default",
  });
});
