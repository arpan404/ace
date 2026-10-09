import { CatalogModel, type ModelSource } from "@ace/protocol";
import { modelDisplayName } from "@ace/models/display-name";
import { serviceLabel } from "@ace/models/service-labels";
import type { FakeDaemon } from "../daemon.ts";

/** Synthetic equivalents of audited legacy selectors and credential-free CLI metadata. */
export function seedRealCatalogs(daemon: FakeDaemon, now: number): void {
  const services = daemon.services;
  services.failingSources.clear();
  const template = services.models.find((model) => model.provider === "opencode");
  if (!template) throw new Error("Missing fixture model");
  const model = (provider: "opencode" | "pi", id: string, source: ModelSource, free = false) =>
    CatalogModel.parse({
      ...template,
      provider,
      instance: provider === "pi" ? "pi-cli-default" : "opencode",
      id,
      nativeModelId: id,
      source,
      free,
      ...modelDisplayName(id),
    });
  const zen: ModelSource = {
    kind: "api_key",
    id: "opencode",
    label: serviceLabel("opencode"),
    service: "opencode_zen",
    requiresAuth: false,
  };
  const go: ModelSource = {
    kind: "subscription",
    id: "opencode-go",
    label: serviceLabel("opencode-go"),
  };
  const local: ModelSource = {
    kind: "local",
    id: "lmstudio",
    label: serviceLabel("lmstudio"),
    requiresAuth: false,
  };
  services.models = services.models
    .filter((row) => !["opencode", "pi"].includes(row.provider))
    .concat([
      model("opencode", "opencode-go/muse-spark-1.3-contributor", go),
      model("opencode", "opencode/big-pickle", zen, true),
      model("opencode", "opencode/exo-free", zen, true),
      model("opencode", "opencode/grok-code-preview-free", zen, true),
      model("opencode", "lmstudio/qwen3-coder", local),
      model("pi", "openai-codex/gpt-6.1-sol", {
        kind: "subscription",
        id: "openai-codex",
        label: serviceLabel("openai-codex"),
      }),
      model("pi", "ollama/qwen3-coder:480b-cloud", {
        kind: "api_key",
        id: "ollama-cloud",
        label: serviceLabel("ollama-cloud"),
      }),
      model("pi", "ollama/qwen3:8b", {
        kind: "local",
        id: "ollama",
        label: serviceLabel("ollama"),
      }),
    ]);
  // A persisted catalog may still carry the old formatter's internal preview tag.
  services.models = services.models.map((row) =>
    row.id === "opencode/grok-code-preview-free"
      ? Object.assign({}, row, { detail: "preview-free" })
      : row,
  );
  services.modelSources.set("opencode", [
    {
      source: { kind: "subscription", id: "github-copilot", label: serviceLabel("github-copilot") },
      status: "fresh",
      error: {
        code: "no_models",
        message: "The connected source has no chat models enabled.",
        hint: "Enable models for it in OpenCode, then Refresh.",
      },
    },
  ]);
  for (const account of services.accounts) {
    if (account.provider === "codex") {
      account.quota.auth = "logged_in";
      account.quota.observedAt = now;
      account.quota.windows = { "codex:primary": { usedPercent: 7, resetsAt: now + 5 * 86400000 } };
      account.availability = "available";
    }
  }
  const codex = services.providerStatuses.find((row) => row.provider === "codex");
  if (codex) Object.assign(codex, { auth: "logged_in", readiness: "signed_in" });
  services.models = services.models.map((row) =>
    row.provider === "claude" && row.id === "claude-opus-5-5"
      ? Object.assign({}, row, { aliases: ["opus"] })
      : row,
  );
  services.settings.seed({
    "providers.configuration": [{ provider: "claude", favourites: ["opus"] }],
  });
  services.usage.sources = [
    "muse-spark-1.3-contributor",
    "opencode-go/muse-spark-1.3-contributor",
  ].map((id) => ({
    provider: "opencode",
    account: "opencode",
    model: id,
    daily: 80000,
    steady: true,
    billing: "api",
    apiUsdPerMillion: null,
    threads: [],
  }));
  const skills = ["clerk", "tdd", "code-review"].map((name) => ({
    id: `real-shape:${name}`,
    name,
    kind: "skill" as const,
    description: `Use the ${name} skill`,
    source: {
      provider: "claude" as const,
      scope: "global" as const,
      path: `/fixture/home/.claude/skills/${name}/SKILL.md`,
    },
    invocation: { type: "slash" as const, name },
  }));
  daemon.seedServices({
    extensionCatalogs: {
      claude: skills,
      pi: skills.map((entry) =>
        Object.assign({}, entry, {
          source: {
            ...entry.source,
            provider: "pi",
            path: `/fixture/home/.pi/agent/skills/${entry.name}/SKILL.md`,
          },
          invocation: { type: "slash", name: `skill:${entry.name}` },
        }),
      ),
    },
  });
}
