/**
 * Which cached media each project may download (ADR 0096): a hash is granted to a project when
 * a resolve under that project answered with it, through that project's own forge access. A
 * device that may read project B therefore can't download an attachment only project A's
 * repository resolved, even knowing its hash. Held in memory and bounded per project; after a
 * restart a download is refused until the page resolves again, which answers from the cache.
 */
export class ForgeMediaGrants {
  private readonly perProject: number;
  /** Hashes by project, least recently granted first. */
  private readonly granted = new Map<string, Set<string>>();
  constructor(perProject = 4096) {
    this.perProject = perProject;
  }
  grant(workspaceId: string, sha256: string): void {
    let hashes = this.granted.get(workspaceId);
    if (!hashes) {
      hashes = new Set();
      this.granted.set(workspaceId, hashes);
    }
    hashes.delete(sha256);
    hashes.add(sha256);
    for (const oldest of hashes) {
      if (hashes.size <= this.perProject) break;
      hashes.delete(oldest);
    }
  }
  allows(workspaceId: string, sha256: string): boolean {
    return this.granted.get(workspaceId)?.has(sha256) ?? false;
  }
}
