import { repositoryKey } from "@ace/forge/project-repositories";

/** What each host supports in this build (ADR 0117); the daemon's own answer wins at run time. */
export { forgeCapabilities } from "@ace/forge/capabilities";
import type { ForgeCapability } from "@ace/protocol/forge-capabilities";
import type { ForgeKind } from "@ace/protocol/forge";

/** Capabilities may be attached to a repository entry, a detail, or a repository itself. */
export interface ForgeCapabilitySource {
  capabilities?: readonly string[] | undefined;
  forge?: ForgeKind | undefined;
  repository?: { forge: ForgeKind; capabilities?: readonly string[] | undefined } | undefined;
  status?: { ref: { repository: { forge: ForgeKind } } } | undefined;
}

/** Explicit declarations win, including an empty list. Older daemons keep their legacy UI. */
export function can(
  source: ForgeCapabilitySource | null | undefined,
  capability: ForgeCapability,
): boolean {
  if (!source) return false;
  const capabilities = source.capabilities ?? source.repository?.capabilities;
  if (capabilities !== undefined) return capabilities.includes(capability);
  const forge = source.forge ?? source.repository?.forge ?? source.status?.ref.repository.forge;
  // An older daemon read GitLab and Cursor Origin reviews only, and nothing from other hosts.
  return (
    forge === "github" ||
    ((forge === "gitlab" || forge === "origin") &&
      (capability === "reviews.read" || capability === "reviews.files"))
  );
}

/** Carry a repository entry's declaration into controls that already have its identity. */
export function repositoryCapabilities(
  repository: { forge: ForgeKind; host: string; owner: string; name: string },
  entries: readonly {
    repository: { forge: ForgeKind; host: string; owner: string; name: string };
    capabilities?: readonly string[] | undefined;
  }[],
): ForgeCapabilitySource {
  const key = repositoryKey(repository);
  const entry = entries.find((each) => repositoryKey(each.repository) === key);
  return entry ?? repository;
}
