export type CompatibilityProfile = Readonly<{
  id: string;
  revision: string;
  agent: string;
  version: string;
  command: string;
  args: readonly string[];
  loginHint: string;
  legacyModel: boolean;
  denySelectors: boolean;
  denyResume: boolean;
  denyHttpMcp?: boolean;
  bridge?: "claude" | "codex";
  env?: Readonly<Record<string, string>>;
}>;
const specs: Omit<CompatibilityProfile, "revision">[] = [
  {
    id: "gemini-043",
    agent: "gemini",
    version: "0.43.0",
    command: "gemini",
    args: ["--acp"],
    loginHint: "gemini",
    legacyModel: true,
    denySelectors: false,
    denyResume: false,
  },
  {
    id: "qwen-old",
    agent: "qwen-code",
    version: "0.0.14",
    command: "qwen",
    args: ["--experimental-acp"],
    loginHint: "qwen: configure a CLI-owned provider; old OAuth claims are obsolete",
    legacyModel: false,
    denySelectors: true,
    denyResume: true,
    denyHttpMcp: true,
  },
  {
    id: "qwen-modern",
    agent: "qwen-code",
    version: "0.24.7",
    command: "qwen",
    args: ["--acp"],
    loginHint: "qwen: configure a CLI-owned provider",
    legacyModel: false,
    denySelectors: false,
    denyResume: false,
  },
  {
    id: "claude-bridge",
    agent: "claude-acp",
    version: "0.85.1",
    command: "claude-agent-acp",
    args: [],
    loginHint: "claude, then /login",
    legacyModel: true,
    denySelectors: false,
    denyResume: false,
    bridge: "claude",
  },
  {
    id: "codex-bridge",
    agent: "codex-acp",
    version: "2.1.1",
    command: "codex-acp",
    args: [],
    loginHint: "codex login",
    legacyModel: true,
    denySelectors: false,
    denyResume: false,
    bridge: "codex",
  },
  {
    id: "goose-153",
    agent: "goose",
    version: "1.53.0",
    command: "goose",
    args: ["acp"],
    loginHint: "goose configure",
    legacyModel: false,
    denySelectors: false,
    denyResume: false,
  },
  {
    id: "auggie-036",
    agent: "auggie",
    version: "0.36.0",
    command: "auggie",
    args: ["--acp"],
    loginHint: "auggie login",
    legacyModel: false,
    denySelectors: false,
    denyResume: false,
    env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
  },
];
export const profiles: readonly CompatibilityProfile[] = Object.freeze(
  specs.map((spec) =>
    Object.freeze({
      ...spec,
      ...(spec.env ? { env: Object.freeze({ ...spec.env }) } : {}),
      args: Object.freeze([...spec.args]),
      revision: "source-2026-10-02",
    }),
  ),
);
export function matchProfile(agent: string, version: string): CompatibilityProfile | undefined {
  return profiles.find((profile) => profile.agent === agent && profile.version === version);
}
/** Source evidence for these commands is unverified at turn level; no isolation claim. */
export function accountIsolation(): { supported: false; reason: string } {
  return {
    supported: false,
    reason: "ACP home and credential-store isolation has not been verified",
  };
}
export function accountMigration(): { supported: false; reason: string } {
  return { supported: false, reason: "ACP migration has no verified CLI-owned strategy" };
}
