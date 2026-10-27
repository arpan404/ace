import type { CatalogModel, ProviderKind } from "@ace/protocol";
import type { RosterAccount, RosterRow } from "./model-roster.ts";

const levels = ["low", "medium", "high", "xhigh", "max"];
const effortList = (ids: readonly string[]) => ids.map((id) => ({ id, level: null, label: id }));

/** Catalog fields to override, with effort ids in place of full effort entries. */
type RowFacts = Partial<CatalogModel> & { effortIds?: readonly string[] };

/** A catalog row as the model catalog reports it after cleanup and classification. */
export function row(
  provider: ProviderKind,
  instance: string,
  id: string,
  displayName: string,
  facts: RowFacts = {},
): RosterRow {
  const { effortIds = levels, ...rest } = facts;
  const model: CatalogModel = {
    id,
    displayName,
    provider,
    instance,
    nativeModelId: id,
    efforts: effortList(effortIds),
    ...(effortIds.length ? { defaultEffort: "high" } : {}),
    serviceTiers: [],
    inputModalities: ["text"],
    isDefault: false,
    hidden: false,
    deprecated: false,
    tier: "current",
    raw: { json: "{}", truncated: false },
    ...rest,
  };
  if (model.tier === "legacy") Object.assign(model, { legacy: true, group: "legacy" });
  return { model, account: instance };
}

export const account = (
  provider: ProviderKind,
  accountId: string,
  facts: Partial<RosterAccount> = {},
): RosterAccount => ({
  provider,
  accountId,
  accountLabel: "Your CLI login",
  auth: "logged_in",
  availability: "available",
  installed: true,
  allowedAccessModes: ["read-only", "ask", "auto-review", "full-access"],
  ...facts,
});

const legacy = { tier: "legacy" } as const;
export const codex346 = "account-e39484b4-ccae-4be1-94ca-154e1231da27";

function claudeRows(): RosterRow[] {
  const claude = (id: string, name: string, facts: Partial<CatalogModel> = {}) =>
    row("claude", "claude-cli-default", id, name, facts);
  return [
    claude("claude-opus-5-5", "Opus 5.5", { isDefault: true, family: "claude-opus" }),
    claude("claude-sonnet-5-5", "Sonnet 5.5", { family: "claude-sonnet" }),
    claude("claude-haiku-5-5", "Haiku 5.5", { family: "claude-haiku" }),
    claude("claude-fable-5-1", "Fable 5.1", { family: "claude-fable" }),
    ...["5", "4-8", "4-7", "4-6"].map((v) =>
      claude(`claude-opus-${v}`, `Opus ${v.replace("-", ".")}`, legacy),
    ),
    claude("claude-sonnet-5", "Sonnet 5", legacy),
    claude("claude-sonnet-4-6", "Sonnet 4.6", legacy),
    row("claude", "claude-cli-default", "claude-haiku-4-5-20251001", "Haiku 4.5", {
      ...legacy,
      effortIds: [],
    }),
    claude("claude-fable-5", "Fable 5", legacy),
  ];
}

/** Two Codex logins: the CLI's own and a second one ("346") that serves the newer releases. */
function codexRows(): RosterRow[] {
  const short = ["low", "medium", "high", "xhigh", "max"];
  const long = [...short, "ultra"];
  const both = (id: string, name: string, facts: Partial<CatalogModel> = {}, on346 = facts) => [
    row("codex", "codex-cli-default", id, name, { effortIds: short, ...facts }),
    row("codex", codex346, id, name, { effortIds: short, ...on346 }),
  ];
  const only346 = (id: string, name: string, facts: Partial<CatalogModel> = {}) =>
    row("codex", codex346, id, name, { effortIds: long, defaultEffort: "low", ...facts });
  return [
    ...both("gpt-reserve", "GPT Reserve", { defaultEffort: "medium" }),
    ...both(
      "gpt-6-luna",
      "GPT-6 Luna",
      { defaultEffort: "medium", isDefault: true },
      {
        defaultEffort: "medium",
      },
    ),
    ...both("codex-auto-review", "Codex Auto Review", { defaultEffort: "medium" }),
    // The CLI login's newest Terra; the second login also has 6.1, so it is superseded there.
    ...both(
      "gpt-5.6-terra",
      "GPT-5.6 Terra",
      { defaultEffort: "medium" },
      { defaultEffort: "medium", ...legacy },
    ),
    ...both("gpt-5.6-luna", "GPT-5.6 Luna", { defaultEffort: "medium", ...legacy }),
    only346("gpt-6.1-sol", "GPT-6.1 Sol", { isDefault: true }),
    only346("gpt-6-astra", "GPT-6 Astra"),
    only346("gpt-6.1-terra", "GPT-6.1 Terra"),
    only346("gpt-6-sol", "GPT-6 Sol", legacy),
    only346("gpt-5.6-sol", "GPT-5.6 Sol", legacy),
  ];
}

/** An OpenCode row on the CLI login, routed through the provider its id names. */
const oc = (id: string, name: string, family: string, facts: RowFacts = {}) =>
  row("opencode", "opencode-cli-default", id, name, {
    family,
    defaultEffort: undefined,
    nativeProviderId: id.slice(0, id.lastIndexOf("/")),
    ...facts,
  });

/** An OpenCode catalogue of three routes and a dozen model lines, as discovery reports it. */
function openCodeRows(): RosterRow[] {
  const lines: [string, string, string, string[]][] = [
    [
      "muse-spark-1.3",
      "Muse Spark 1.3",
      "muse-spark",
      ["minimal", "low", "medium", "high", "xhigh"],
    ],
    ["claude-opus-5-5", "Claude Opus 5.5", "claude-opus", levels],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5", "claude-sonnet", levels],
    ["claude-fable-5-1", "Claude Fable 5.1", "claude-fable", levels],
    ["claude-haiku-5-5", "Claude Haiku 5.5", "claude-haiku", ["none", ...levels]],
    ["gpt-6.1-sol", "GPT-6.1 Sol", "gpt-sol", [...levels, "ultra"]],
    ["gemini-4-pro", "Gemini 4 Pro", "gemini", ["low", "high"]],
    ["grok-5", "Grok 5", "grok", ["low", "high"]],
    ["kimi-k3", "Kimi K3", "kimi", ["low", "high", "max"]],
    ["qwen3.8-max", "Qwen3.8 Max", "qwen", ["none", "low", "medium", "xhigh"]],
    ["glm-5.3", "GLM 5.3", "glm", ["low", "high", "max"]],
    ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", "deepseek", ["low", "high", "max"]],
    ["minimax-m3", "MiniMax M3", "minimax", ["low", "high"]],
  ];
  const rows: RosterRow[] = [
    oc("opencode-go/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor", "muse-spark", {
      isDefault: true,
      effortIds: ["minimal", "low", "medium", "high", "xhigh"],
    }),
  ];
  for (const route of ["opencode", "opencode-go", "openrouter"])
    for (const [id, name, family, effortIds] of lines)
      rows.push(oc(`${route}/${id}`, name, family, { effortIds }));
  const older: [string, string, string][] = [
    ["claude-opus-5", "Claude Opus 5", "claude-opus"],
    ["claude-opus-4-8", "Claude Opus 4.8", "claude-opus"],
    ["gpt-6-sol", "GPT-6 Sol", "gpt-sol"],
    ["gemini-3-pro", "Gemini 3 Pro", "gemini"],
    ["kimi-k2.7-code", "Kimi K2.7 Code", "kimi"],
    ["qwen3.6-plus", "Qwen3.6 Plus", "qwen"],
    ["glm-5", "GLM 5", "glm"],
    ["deepseek-v4-pro", "DeepSeek V4 Pro", "deepseek"],
  ];
  for (const route of ["opencode", "openrouter"])
    for (const [id, name, family] of older)
      rows.push(oc(`${route}/${id}`, name, family, { ...legacy, effortIds: ["low", "high"] }));
  return rows;
}

/** The owner's install: Claude, two Codex logins, a large OpenCode catalogue, three more CLIs. */
export function realisticInstall() {
  return {
    rows: [...codexRows(), ...claudeRows(), ...openCodeRows()],
    accounts: [
      account("cursor", "account-3655eb7d-0128-4396-b966-6b3809276ff9", {
        accountLabel: "w10",
        allowedAccessModes: ["auto-review", "full-access"],
      }),
      account("codex", "codex-cli-default", { auth: "unknown", availability: "unknown" }),
      account("claude", "claude-cli-default", { availability: "near_limit" }),
      account("opencode", "opencode-cli-default", {
        auth: "unknown",
        availability: "unknown",
        allowedAccessModes: ["read-only", "ask", "full-access"],
      }),
      account("pi", "pi-cli-default", {
        auth: "unknown",
        availability: "unknown",
        allowedAccessModes: ["read-only", "full-access"],
      }),
      account("antigravity", "antigravity-cli-default", {
        accountLabel: "Antigravity",
        allowedAccessModes: [],
      }),
      account("codex", codex346, { accountLabel: "346" }),
    ],
  };
}
