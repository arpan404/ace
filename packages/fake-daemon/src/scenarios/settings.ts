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
  extra: { isDefault?: boolean; contextWindow?: number; efforts?: string[] } = {},
): CatalogModel {
  return CatalogModel.parse({
    id: `${provider}:${id}`,
    displayName,
    provider,
    instance,
    nativeModelId: id,
    contextWindow: extra.contextWindow,
    reasoningEfforts: extra.efforts ?? [],
    serviceTiers: [],
    inputModalities: ["text", "image"],
    isDefault: extra.isDefault ?? false,
    hidden: false,
    deprecated: false,
    raw: { json: JSON.stringify({ id }), truncated: false },
  });
}

export function settingsFixture(now: number): SettingsFixture {
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
        kind: "cursor",
        name: "Cursor",
        binary: "cursor-agent",
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
    models: [
      model("claude", "claude-personal", "claude-opus-4-1", "Opus 4.1", {
        isDefault: true,
        contextWindow: 200_000,
        efforts: ["low", "medium", "high"],
      }),
      model("claude", "claude-personal", "claude-sonnet-4-5", "Sonnet 4.5", {
        contextWindow: 1_000_000,
        efforts: ["low", "medium", "high"],
      }),
      model("claude", "claude-personal", "claude-haiku-4-5", "Haiku 4.5", {
        contextWindow: 200_000,
      }),
      model("codex", "codex-personal", "gpt-5-codex", "GPT-5 Codex", {
        isDefault: true,
        contextWindow: 400_000,
        efforts: ["minimal", "low", "medium", "high"],
      }),
      model("codex", "codex-personal", "gpt-5", "GPT-5", {
        contextWindow: 400_000,
        efforts: ["minimal", "low", "medium", "high"],
      }),
      model("opencode", "opencode", "anthropic/claude-sonnet-4-5", "Sonnet 4.5 (OpenCode)", {
        isDefault: true,
      }),
      model("cursor", "cursor", "auto", "Auto", { isDefault: true }),
      model("acp", "gemini-google", "gemini-2.5-pro", "Gemini 2.5 Pro", {
        isDefault: true,
        contextWindow: 1_000_000,
      }),
    ],
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
        lastSeenAt: now - 20_000,
      },
    ],
    devices: [
      Device.parse({
        id: "device-iphone",
        name: "iPhone 16 Pro",
        scopes: ["read", "operate"],
        createdAt: now - 12 * 24 * 60 * minute,
        lastSeenAt: now - 2 * minute,
        revokedAt: null,
      }),
      Device.parse({
        id: "device-ipad",
        name: "iPad Air",
        scopes: ["read"],
        createdAt: now - 40 * 24 * 60 * minute,
        lastSeenAt: now - 6 * 24 * 60 * minute,
        revokedAt: null,
      }),
    ],
    values: {
      "providers.default": "claude",
      "notifications.enabled": true,
      "notifications.sound": true,
      "notifications.onCompletion": true,
      "notifications.onApproval": true,
      "notifications.suppressWhenActive": true,
      "remote.enabled": true,
      "remote.transport": "tailscale",
    },
  };
}
