import type { ProjectRepository } from "@ace/protocol";
import { forgeDisplayName } from "./forge-hosts.ts";

/*
 * The words a project's settings show under each repository (ADR 0116): where it comes from,
 * or why ace can't use it now and what fixes that. Web and the iPhone share them. Pure.
 */

/** "Remote origin", "Added by hand". */
export function repositorySourceText(entry: ProjectRepository): string {
  return entry.source === "remote" && entry.remote ? `Remote ${entry.remote}` : "Added by hand";
}

/** Whether what fixes an unavailable repository is in Source control settings. */
export function fixedInSourceControl(entry: ProjectRepository): boolean {
  return entry.unavailable === "host_not_configured" || entry.unavailable === "provider_mismatch";
}

/** Why ace can't use this repository now and what fixes it; undefined when it can. */
export function repositoryUnavailableText(entry: ProjectRepository): string | undefined {
  const { host, forge } = entry.repository;
  switch (entry.unavailable) {
    case undefined:
      return undefined;
    case "host_not_configured":
      return `${host} isn't one of your Git hosts. Add it in Source control settings.`;
    case "provider_mismatch":
      return `${host} is set up as another provider now. Check it in Source control settings.`;
    case "provider_unsupported":
      return `ace can't read pull requests from ${forgeDisplayName(forge)} yet.`;
    case "remote_missing":
      return "No remote names it any more. Add the remote again, or make another repository primary.";
  }
}
