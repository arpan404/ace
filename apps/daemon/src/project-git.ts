import type { RepositoryInfo } from "@ace/git";

/** Project metadata must not turn credential-bearing Git config into a client response. */
export function projectRemotes(remotes: RepositoryInfo["remotes"]): RepositoryInfo["remotes"] {
  return remotes.slice(0, 64).map((remote) => ({
    name: remote.name.slice(0, 256),
    fetchUrls: remote.fetchUrls.filter(publicRemote).slice(0, 32),
    pushUrls: remote.pushUrls.filter(publicRemote).slice(0, 32),
  }));
}
function publicRemote(value: string): boolean {
  if (value.length > 4096) return false;
  try {
    const url = new URL(value);
    return !url.password && (!["http:", "https:"].includes(url.protocol) || !url.username);
  } catch {
    // SCP syntax and local path remotes have no URL credential fields.
    return true;
  }
}
