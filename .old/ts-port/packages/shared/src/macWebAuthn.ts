export const MAC_WEBAUTHN_RUNTIME_CONFIG_FILE = "desktop-runtime-config.json";
export const MAC_WEBAUTHN_KEYCHAIN_ACCESS_GROUP_ENV =
  "ACE_DESKTOP_MAC_WEBAUTHN_KEYCHAIN_ACCESS_GROUP";
export const MAC_WEBAUTHN_TEAM_ID_ENV = "ACE_DESKTOP_MAC_TEAM_ID";
export const APPLE_TEAM_ID_ENV = "APPLE_TEAM_ID";
export const MAC_WEBAUTHN_PROMPT_REASON = "sign in to $1";

const MAC_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
const MAC_KEYCHAIN_ACCESS_GROUP_PATTERN = /^[A-Z0-9]{10}\.[A-Za-z0-9][A-Za-z0-9.-]*$/;

export interface MacWebAuthnRuntimeConfig {
  readonly macWebAuthnKeychainAccessGroup?: string;
}

export function normalizeMacTeamId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return MAC_TEAM_ID_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeMacWebAuthnKeychainAccessGroup(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return MAC_KEYCHAIN_ACCESS_GROUP_PATTERN.test(normalized) ? normalized : null;
}

export function createMacWebAuthnKeychainAccessGroup(input: {
  readonly appBundleId: string;
  readonly teamId: string;
}): string | null {
  const teamId = normalizeMacTeamId(input.teamId);
  if (!teamId) return null;

  const appBundleId = input.appBundleId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(appBundleId)) {
    return null;
  }

  return `${teamId}.${appBundleId}.webauthn`;
}

export function parseMacWebAuthnRuntimeConfig(rawConfig: string): MacWebAuthnRuntimeConfig | null {
  try {
    const parsed = JSON.parse(rawConfig) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const keychainAccessGroup = normalizeMacWebAuthnKeychainAccessGroup(
      (parsed as { readonly macWebAuthnKeychainAccessGroup?: unknown })
        .macWebAuthnKeychainAccessGroup,
    );
    return keychainAccessGroup ? { macWebAuthnKeychainAccessGroup: keychainAccessGroup } : {};
  } catch {
    return null;
  }
}

export function resolveMacWebAuthnKeychainAccessGroup(input: {
  readonly appBundleId: string;
  readonly env?: Partial<Record<string, string | undefined>>;
  readonly runtimeConfig?: MacWebAuthnRuntimeConfig | null | undefined;
  readonly teamId?: string | null | undefined;
}): string | null {
  const env = input.env ?? {};
  const explicitGroup =
    normalizeMacWebAuthnKeychainAccessGroup(env[MAC_WEBAUTHN_KEYCHAIN_ACCESS_GROUP_ENV]) ??
    normalizeMacWebAuthnKeychainAccessGroup(input.runtimeConfig?.macWebAuthnKeychainAccessGroup);
  if (explicitGroup) {
    return explicitGroup;
  }

  const teamId =
    normalizeMacTeamId(input.teamId) ??
    normalizeMacTeamId(env[MAC_WEBAUTHN_TEAM_ID_ENV]) ??
    normalizeMacTeamId(env[APPLE_TEAM_ID_ENV]);
  if (!teamId) {
    return null;
  }

  return createMacWebAuthnKeychainAccessGroup({
    appBundleId: input.appBundleId,
    teamId,
  });
}
