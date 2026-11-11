import type { ForgeRepository } from "@ace/protocol";
import { can, repositoryCapabilities, type ForgeCapabilitySource } from "@ace/ui-core";
import type { ForgeReads } from "./forge-reads.ts";

/** Resolve entry declarations before using a repository identity's legacy fallback. */
export async function capabilitySource(
  reads: ForgeReads,
  project: string,
  repository?: ForgeRepository,
): Promise<ForgeCapabilitySource | undefined> {
  const listed = await reads.repositories(project).catch(() => undefined);
  if (listed) {
    const selected = repository ?? listed.primary ?? undefined;
    return selected ? repositoryCapabilities(selected, listed.repositories) : undefined;
  }
  if (repository) return repository;
  const value = await reads.read({ op: "forge.repository", workspaceId: project }, true);
  return value.resource === "repository" ? value.value : undefined;
}

/** The navigation follows any readable issue source and the primary's inbox and create support. */
export async function readFeatures(reads: ForgeReads, project: string) {
  const listed = await reads.repositories(project).catch(() => undefined);
  const primary = listed
    ? listed.repositories.find((entry) => entry.primary && entry.visible && entry.available)
    : await capabilitySource(reads, project);
  const visible = listed?.repositories.filter((entry) => entry.visible && entry.available) ?? [];
  return {
    issues: listed
      ? visible.some((entry) => can(entry, "issues.read"))
      : can(primary, "issues.read"),
    inbox: can(primary, "inbox"),
    create: can(primary, "reviews.create"),
  };
}
