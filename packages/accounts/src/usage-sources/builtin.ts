import type { ProviderInstance } from "@ace/protocol/accounts";
import { UsageSource, type UsageDeclaration } from "./declaration.ts";

/*
 * The usage sources ace ships, keyed by native provider or ACP registry agent id. A new ACP
 * agent gets usage by adding an entry here: data checked by the declaration schema, no code.
 * Each entry names its primary source; see ADR 0018's usage amendment.
 */

const declarations: Record<string, UsageDeclaration> = {};

/** The usage source declared for an account's provider or ACP agent, if any. */
export function usageDeclaration(
  instance: Pick<ProviderInstance, "provider" | "acpAgentId">,
): UsageDeclaration | undefined {
  const key = instance.provider === "acp" ? instance.acpAgentId : instance.provider;
  return key !== undefined && Object.hasOwn(declarations, key) ? declarations[key] : undefined;
}

/** Every declaration, checked against the schema when ace starts rather than at first use. */
export function declaredSources(): readonly [string, UsageDeclaration][] {
  return Object.entries(declarations).map(([key, value]) => [
    key,
    { ...value, sources: value.sources.map((source) => UsageSource.parse(source)) },
  ]);
}
