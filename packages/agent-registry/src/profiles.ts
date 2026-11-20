import { compareCliVersions, parseCliVersion } from "@ace/provider-kit/cli-versions";

export type CompatibilityProfile = Readonly<{
  id: string;
  revision: string;
  agent: string;
  /** The exact version the profile was verified against. */
  version: string;
  /**
   * Versions the profile still fits without being verified on them (ADR 0044 amendment, agents
   * that update themselves). Omitted: the verified version's major, from the verified version up.
   * `below` is exclusive.
   */
  compatible?: Readonly<{ below: string }>;
  command: string;
  args: readonly string[];
  loginHint: string;
  legacyModel: boolean;
  denySelectors: boolean;
  denyResume: boolean;
  denyHttpMcp?: boolean;
  bridge?: "claude" | "codex";
  subagentSessions?: true;
  login?: Readonly<{ binary: "agent" | "native"; args: readonly string[] }>;
  env?: Readonly<Record<string, string>>;
}>;
const specs: Omit<CompatibilityProfile, "revision">[] = [
  {
    id: "gemini-043",
    login: { binary: "agent", args: [] },
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
    login: { binary: "agent", args: [] },
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
    login: { binary: "agent", args: [] },
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
    login: { binary: "native", args: ["auth", "login"] },
    agent: "claude-acp",
    version: "0.85.1",
    command: "claude-agent-acp",
    args: [],
    loginHint: "claude, then /login",
    legacyModel: true,
    denySelectors: false,
    denyResume: false,
    bridge: "claude",
    subagentSessions: true,
  },
  {
    id: "codex-bridge",
    login: { binary: "native", args: ["login"] },
    agent: "codex-acp",
    version: "2.1.1",
    command: "codex-acp",
    args: [],
    loginHint: "codex login",
    legacyModel: true,
    denySelectors: false,
    denyResume: false,
    bridge: "codex",
    subagentSessions: true,
  },
  {
    id: "goose-153",
    login: { binary: "agent", args: ["configure"] },
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
    login: { binary: "agent", args: ["login"] },
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
      ...(spec.login
        ? { login: Object.freeze({ ...spec.login, args: Object.freeze([...spec.login.args]) }) }
        : {}),
      revision: "source-2026-10-02",
    }),
  ),
);
/** How a profile covers a version: the one it was verified on, or its compatible range. */
export type ProfileFit = "verified" | "compatible";

/**
 * Whether `version` is in `profile`'s range: exactly the verified version, or, by default, the
 * same major version and not older than the verified one. An unreadable version only fits
 * exactly. A prerelease of the verified version is older than it, so it doesn't fit.
 */
export function profileFit(profile: CompatibilityProfile, version: string): ProfileFit | undefined {
  if (version === profile.version) return "verified";
  const reported = parseCliVersion(version);
  const verified = parseCliVersion(profile.version);
  if (!reported || !verified) return undefined;
  if (compareCliVersions(reported, verified) < 0) return undefined;
  const ceiling = profile.compatible
    ? parseCliVersion(profile.compatible.below)
    : { major: verified.major + 1, minor: 0, patch: 0, prerelease: ["0"] };
  if (!ceiling || compareCliVersions(reported, ceiling) >= 0) return undefined;
  return compareCliVersions(reported, verified) === 0 ? "verified" : "compatible";
}

/**
 * The profile an agent at `version` runs under, and how it fits: the verified one when a
 * profile names that version, else the compatible profile verified on the newest version not
 * above it. None outside every range: the agent runs as generic ACP.
 */
export function profileFor(
  agent: string,
  version: string,
): { profile: CompatibilityProfile; fit: ProfileFit } | undefined {
  let best: { profile: CompatibilityProfile; fit: ProfileFit } | undefined;
  for (const profile of profiles) {
    if (profile.agent !== agent) continue;
    const fit = profileFit(profile, version);
    if (fit === "verified") return { profile, fit };
    if (!fit) continue;
    const order = (candidate: CompatibilityProfile) =>
      parseCliVersion(candidate.version) ?? { major: 0, minor: 0, patch: 0, prerelease: [] };
    if (!best || compareCliVersions(order(profile), order(best.profile)) > 0)
      best = { profile, fit };
  }
  return best;
}

export function matchProfile(agent: string, version: string): CompatibilityProfile | undefined {
  return profileFor(agent, version)?.profile;
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
