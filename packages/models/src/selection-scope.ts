import type { AcpIdentity, ModelFilter, ProviderKind } from "@ace/protocol";

/** Execution without an account means the native CLI, never an arbitrary account.
 * ACP catalogue IDs are opaque; its source-qualified identity selects the rows. */
export function selectionModelFilter(
  provider: ProviderKind,
  instance?: string,
  identity?: AcpIdentity,
): ModelFilter | undefined {
  if (provider === "acp") return identity ? { provider, ...identity } : undefined;
  return { provider, instance: instance ?? `${provider}-cli-default` };
}
