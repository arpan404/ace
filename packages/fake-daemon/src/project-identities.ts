import {
  ProjectIdentity,
  maxIdentityAliases,
  type ProjectIdentitySource,
  type WorkspaceId,
} from "@ace/protocol";

/*
 * Logical project identity as the real daemon keeps it (ADR 0180): one per registration, made on
 * add, clone or create, and changed only by link, unlink, merge or a transfer. Aliases are kept
 * flat, the most recent `maxIdentityAliases` reported. With `enabled` false it speaks as a
 * daemon from before identities: none are reported and identity requests are refused.
 */
export class FakeIdentities {
  enabled = true;
  /** While set, identity commands are refused, as a daemon that couldn't write would (tests). */
  refusing = false;
  private rows = new Map<string, { id: string; source: ProjectIdentitySource }>();
  private aliases = new Map<string, { to: string; at: number }>();
  private minted = 0;
  private writes = 0;
  /** A fresh identity id, in UUID form, distinct per fake daemon by `seed`. */
  private mint(): string {
    const n = (++this.minted).toString(16).padStart(12, "0");
    return `${this.seed}-0000-4000-8000-${n}`;
  }
  private seed = "00000000";
  /** Ids minted from here on differ from another fake daemon's: `text` is its host id. */
  reseed(text: string): void {
    let hash = 0x811c9dc5;
    for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    this.seed = hash.toString(16).padStart(8, "0");
  }
  /** A registration ace made now (or shared): its own logical project, unless it has one. */
  created(workspaceId: string): void {
    if (this.enabled && !this.rows.has(workspaceId))
      this.rows.set(workspaceId, { id: this.mint(), source: "created" });
  }
  /** Seed or set a registration's identity directly (tests, transfers). */
  set(workspaceId: string, id: string, source: ProjectIdentitySource = "linked"): void {
    this.rows.set(workspaceId, { id, source });
  }
  /** Seed an alias as a merge on this machine would have kept it. */
  alias(from: string, to: string): void {
    this.aliases.set(from, { to, at: ++this.writes });
  }
  identity(workspaceId: string): ProjectIdentity | undefined {
    if (!this.enabled) return undefined;
    const row = this.rows.get(workspaceId);
    if (!row) return undefined;
    const aliases = [...this.aliases]
      .filter(([from, alias]) => alias.to === row.id && from !== row.id)
      .toSorted((a, b) => b[1].at - a[1].at)
      .slice(0, maxIdentityAliases)
      .map(([from]) => from);
    return ProjectIdentity.parse({ id: row.id, aliases, source: row.source });
  }
  /** Link: returns whether anything changed. */
  link(workspaceId: string, identityId: string, source: "linked" | "marker" = "linked"): boolean {
    if (this.rows.get(workspaceId)?.id === identityId) return false;
    this.rows.set(workspaceId, { id: identityId, source });
    return true;
  }
  unlink(workspaceId: string): void {
    this.rows.set(workspaceId, { id: this.mint(), source: "created" });
  }
  /** Merge `from` into `into`; returns the registrations whose reported identity changed. */
  merge(from: string, into: string): WorkspaceId[] {
    const target = this.aliases.get(into)?.to ?? into;
    if (from === target) return [];
    for (const [workspaceId, row] of this.rows)
      if (row.id === from) this.rows.set(workspaceId, { id: target, source: "linked" });
    for (const [alias, entry] of this.aliases)
      if (entry.to === from) this.aliases.set(alias, { ...entry, to: target });
    for (const [alias, entry] of this.aliases) if (alias === entry.to) this.aliases.delete(alias);
    this.aliases.set(from, { to: target, at: ++this.writes });
    return [...this.rows]
      .filter(([, row]) => row.id === target)
      .map(([workspaceId]) => workspaceId as WorkspaceId);
  }
}
