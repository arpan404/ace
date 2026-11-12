import type { SpadeEndpoint } from "./wire.ts";

/*
 * Settings › Spade in words: each endpoint's key line and which role each model serves. A key
 * is never shown; clients see only whether one is set and where it comes from (ADR 0119).
 */

const roleNames: Record<string, string> = { main: "Main", fast: "Fast", deep: "Deep" };

/** "Spade's Main, Fast model" for a model some role uses; undefined when none does. */
export function spadeModelRoles(
  roles: Record<string, string>,
  endpoint: string,
  model: string,
): string | undefined {
  const named = Object.entries(roles)
    // Spade names a role's model as `endpoint/model`.
    .filter(([, picked]) => picked === `${endpoint}/${model}`)
    .map(([role]) => roleNames[role] ?? role);
  return named.length ? `Spade's ${named.join(", ")} model` : undefined;
}

/** What an endpoint's Key row says and offers. */
export interface SpadeKeyLine {
  description: string;
  /** A key can be typed here and saved to the machine's keychain. */
  canSave: boolean;
  /** Only a key in the keychain can be removed from here; the environment's stays. */
  canRemove: boolean;
  placeholder: string;
}

export function spadeKeyLine(endpoint: SpadeEndpoint, keychain: boolean): SpadeKeyLine {
  if (!keychain)
    return {
      description:
        endpoint.keySource === "environment"
          ? "Set from the environment."
          : "This machine has no keychain. Set the endpoint's environment variable for Spade.",
      canSave: false,
      canRemove: false,
      placeholder: "",
    };
  return {
    description:
      endpoint.keySource === "environment"
        ? "Set from the environment. A key saved here is used instead."
        : endpoint.keySet
          ? "Set"
          : "Not set. Spade can't use these models without it.",
    canSave: true,
    canRemove: endpoint.keySource === "keychain",
    placeholder: endpoint.keySet ? "Replace key" : "Paste key",
  };
}
