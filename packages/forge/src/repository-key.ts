import type { ForgeRepository } from "@ace/protocol/forge";

/** Canonical key also keeps repository identity insensitive to GitHub URL case. */
export function repositoryKey(repo: ForgeRepository): string {
  return JSON.stringify({
    forge: repo.forge,
    host: repo.host.toLowerCase(),
    owner: repo.owner.toLowerCase(),
    name: repo.name.toLowerCase(),
  });
}
