import { configuredModels } from "@ace/models/preferences";
import { modelDisplayName } from "@ace/models/display-name";
import { CatalogModel, Device, type ProviderKind, type SettingsValues } from "@ace/protocol";

/**
 * Data behind Settings: the provider CLIs discovery found on this machine, their logins and
 * models, the machines and phones paired with the daemon, and the daemon's stored settings.
 * Matches the approved design (Claude Code and Codex with two accounts each, one at its limit;
 * OpenCode and Cursor signed in; Gemini via ACP; a Linux build box and a paired iPhone).
 */
/** A CLI login as Settings lists it; usage windows live in catalog/accounts.ts. */
export interface FakeLogin {
  id: string;
  label: string;
  plan: string;
  auth: "logged_in" | "logged_out";
  availability: "available" | "near_limit" | "exhausted" | "logged_out";
}

export interface FakeProviderInstall {
  kind: ProviderKind;
  name: string;
  /** The executable discovery found, e.g. `claude`. */
  binary: string;
  version: string | null;
  /** "via ACP" for agents ace reaches through the Agent Client Protocol. */
  via?: string;
  accounts: FakeLogin[];
}

export interface FakeMachine {
  id: string;
  name: string;
  platform: "macos" | "linux" | "windows";
  current: boolean;
  threads: number;
  daemonVersion: string;
  online: boolean;
  lastSeenAt: number;
}

export interface SettingsFixture {
  providers: FakeProviderInstall[];
  models: CatalogModel[];
  machines: FakeMachine[];
  devices: Device[];
  values: Partial<SettingsValues> & Record<string, unknown>;
}

const minute = 60_000;

function model(
  provider: ProviderKind,
  instance: string,
  id: string,
  displayName: string,
  extra: {
    free?: boolean;
    isDefault?: boolean;
    contextWindow?: number;
    efforts?: string[];
    defaultEffort?: string;
    /** Offers Codex's priority tier, which the composer's speed toggle asks for. */
    fast?: boolean;
    isNew?: boolean;
    deprecated?: boolean;
    source?: CatalogModel["source"];
  } = {},
): CatalogModel {
  return CatalogModel.parse({
    // Catalog ids repeat on every account that serves the model, as the daemon's do.
    id,
    free: extra.free,
    ...modelDisplayName(id, displayName),
    ...(extra.source
      ? { source: extra.source, nativeProviderId: extra.source.id }
      : {
          source: {
            kind: "account",
            id: instance,
            label: instance.endsWith("personal")
              ? "Personal"
              : /work|team/.test(instance)
                ? "Work"
                : "Default",
          },
        }),
    provider,
    instance,
    // ACP rows carry the source identity a thread starts with.
    ...(provider === "acp"
      ? { acpAgentId: "Gemini CLI", installationId: "installed", instanceId: instance }
      : {}),
    nativeModelId: id,
    contextWindow: extra.contextWindow,
    reasoningEfforts: extra.efforts ?? [],
    ...(extra.defaultEffort ? { defaultEffort: extra.defaultEffort } : {}),
    serviceTiers: extra.fast
      ? [
          {
            id: "default",
            name: "Standard",
            speed: "standard",
            parameters: { serviceTier: "default" },
          },
          { id: "priority", name: "Fast", speed: "fast", parameters: { serviceTier: "priority" } },
        ]
      : [],
    inputModalities: ["text", "image"],
    isDefault: extra.isDefault ?? false,
    hidden: false,
    deprecated: extra.deprecated ?? false,
    ...(extra.isNew ? { isNew: true } : {}),
    raw: { json: JSON.stringify({ id }), truncated: false },
  });
}

export function settingsFixture(now: number): SettingsFixture {
  // Test clocks can start at epoch zero; fixture history must remain a valid timestamp.
  const ago = (age: number) => Math.max(0, now - age);
  return {
    providers: [
      {
        kind: "claude",
        name: "Claude Code",
        binary: "claude",
        version: "2.1.4",
        accounts: [
          {
            id: "claude-personal",
            label: "Personal",
            plan: "Max",
            auth: "logged_in",
            availability: "available",
          },
          {
            id: "claude-work",
            label: "Work",
            plan: "Team",
            auth: "logged_in",
            availability: "available",
          },
        ],
      },
      {
        kind: "codex",
        name: "Codex",
        binary: "codex",
        version: "0.48",
        accounts: [
          {
            id: "codex-personal",
            label: "Personal",
            plan: "ChatGPT Pro",
            auth: "logged_in",
            availability: "available",
          },
          {
            id: "codex-team",
            label: "Team",
            plan: "ChatGPT Plus",
            auth: "logged_in",
            availability: "exhausted",
          },
        ],
      },
      {
        kind: "opencode",
        name: "OpenCode",
        binary: "opencode",
        version: "1.4",
        accounts: [
          {
            id: "opencode",
            label: "Default",
            plan: "",
            auth: "logged_in",
            availability: "available",
          },
        ],
      },
      {
        kind: "pi",
        name: "Pi",
        binary: "pi",
        version: "0.85.1",
        accounts: [
          { id: "pi", label: "Default", plan: "", auth: "logged_in", availability: "available" },
        ],
      },
      {
        kind: "cursor",
        name: "Cursor",
        binary: "@cursor/sdk",
        version: "0.9",
        accounts: [
          {
            id: "cursor",
            label: "Default",
            plan: "Pro",
            auth: "logged_in",
            availability: "available",
          },
        ],
      },
      {
        kind: "acp",
        name: "Gemini CLI",
        binary: "gemini",
        version: "0.21",
        via: "via ACP",
        accounts: [
          {
            id: "gemini-google",
            label: "Google",
            plan: "Code Assist",
            auth: "logged_in",
            availability: "available",
          },
        ],
      },
      {
        kind: "antigravity",
        name: "Antigravity",
        binary: "antigravity",
        version: null,
        accounts: [],
      },
    ],
    models: modelCatalog(),
    machines: [
      {
        id: "studio-mac",
        name: "studio-mac",
        platform: "macos",
        current: true,
        threads: 9,
        daemonVersion: "0.8.0",
        online: true,
        lastSeenAt: now,
      },
      {
        id: "build-box",
        name: "build-box",
        platform: "linux",
        current: false,
        threads: 3,
        daemonVersion: "0.8.0",
        online: true,
        lastSeenAt: ago(20_000),
      },
    ],
    devices: [
      Device.parse({
        id: "device-iphone",
        name: "iPhone 16 Pro",
        scopes: ["read", "operate"],
        createdAt: ago(12 * 24 * 60 * minute),
        lastSeenAt: ago(2 * minute),
        revokedAt: null,
      }),
      Device.parse({
        id: "device-ipad",
        name: "iPad Air",
        scopes: ["read"],
        createdAt: ago(40 * 24 * 60 * minute),
        lastSeenAt: ago(6 * 24 * 60 * minute),
        revokedAt: null,
      }),
    ],
    values: settingsValues(),
  };
}

/** The models discovery found on this machine's signed-in accounts (`models.list`). */
export function modelCatalog(): CatalogModel[] {
  const rows: CatalogModel[] = [];
  for (const instance of ["claude-personal", "claude-work"]) {
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-6",
      "claude-sonnet-4-5",
      "claude-opus-4-1",
      "claude-opus-4",
    ]) {
      rows.push(
        model("claude", instance, id, modelDisplayName(id).displayName, {
          contextWindow: 200_000,
          efforts: ["low", "medium", "high"],
        }),
      );
    }
  }
  for (const instance of ["codex-personal", "codex-team"]) {
    for (const id of [
      "gpt-6",
      "gpt-6.1-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-6-sol",
      "gpt-5.5",
      "gpt-5-codex",
      "gpt-5",
    ]) {
      rows.push(
        model("codex", instance, id, modelDisplayName(id).displayName, {
          contextWindow: 400_000,
          efforts: ["minimal", "low", "medium", "high"],
          defaultEffort: "medium",
          fast: true,
        }),
      );
    }
  }
  rows.push(
    model("opencode", "opencode", "opencode/big-pickle", "Big Pickle", {
      free: true,
      source: { kind: "api_key", id: "opencode", label: "OpenCode Zen", service: "opencode_zen" },
    }),
  );
  const sources: NonNullable<CatalogModel["source"]>[] = [
    { kind: "local", id: "ollama", label: "Ollama" },
    { kind: "local", id: "lmstudio", label: "LM Studio" },
    { kind: "subscription", id: "opencode-go", label: "OpenCode Go", service: "opencode_go" },
    { kind: "api_key", id: "opencode", label: "OpenCode Zen", service: "opencode_zen" },
    { kind: "api_key", id: "anthropic", label: "Anthropic" },
    { kind: "api_key", id: "openai", label: "OpenAI" },
    { kind: "api_key", id: "openrouter", label: "OpenRouter" },
  ];
  for (const source of sources) {
    const ids =
      source.kind === "local"
        ? ["qwen3-235b-a22b", "qwen2-72b"]
        : source.id === "opencode-go"
          ? ["muse-spark-1.3-contributor", "muse-spark-1.2-contributor"]
          : source.id === "openai"
            ? ["gpt-6.1-sol", "gpt-5.6-sol"]
            : ["claude-opus-5-5", "claude-opus-4-8", "claude-sonnet-4-5"];
    for (const id of ids)
      rows.push(
        model("opencode", "opencode", `${source.id}/${id}`, modelDisplayName(id).displayName, {
          source,
        }),
      );
  }
  // The isolated API account reports its own failing service, as a real catalog instance does.
  rows.push(
    ...rows
      .filter((row) => row.provider === "opencode" && row.source?.id === "openrouter")
      .map((row) => Object.assign({}, row, { instance: "opencode-api" })),
  );
  for (const source of [
    { kind: "subscription", id: "github-copilot", label: "GitHub Copilot" },
    { kind: "other", id: "anthropic", label: "Anthropic" },
  ] satisfies NonNullable<CatalogModel["source"]>[]) {
    for (const id of ["claude-opus-5-5", "claude-opus-4-8", "claude-haiku-4-5"])
      rows.push(
        model("pi", "pi", `${source.id}/${id}`, modelDisplayName(id).displayName, { source }),
      );
  }
  for (const id of ["auto", "composer-2.5", "composer-2", "claude-opus-5-5", "claude-opus-4-8"])
    rows.push(model("cursor", "cursor", id, modelDisplayName(id).displayName));
  rows.push(
    model("acp", "gemini-google", "gemini-2.5-pro", "Gemini 2.5 Pro", {
      isDefault: true,
      contextWindow: 1_000_000,
    }),
  );
  const groups = new Map<string, CatalogModel[]>();
  for (const row of rows) {
    const key = row.instance;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const first = group[0];
    return first
      ? configuredModels(group, first.provider, first.instance, { provider: first.provider })
      : [];
  });
}

/** What the daemon's settings file holds on the global layer. */
export function settingsValues(): Partial<SettingsValues> & Record<string, unknown> {
  return {
    "providers.default": "claude",
    "remote.enabled": true,
    "remote.transport": "tailscale",
  };
}
