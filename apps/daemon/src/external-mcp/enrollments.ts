import { randomBytes, randomUUID } from "node:crypto";
import { CredentialRegistry, nodeScheduler, type SessionLease } from "@ace/mcp-server";
import { AgentId, ThreadId, type WorkspaceId, type McpAttribution } from "@ace/protocol";
export interface Enrollment {
  id: string;
  scope: "read" | "operate";
  project?: WorkspaceId;
  expiresAt: number;
  /** Set for a lease the daemon holds for its own process (Spade), revoked when it stops. */
  holder?: "spade";
}
export class Enrollments {
  readonly credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"), 64);
  private entries = new Map<string, Enrollment & { end: SessionLease["end"]; cancel(): void }>();
  private now: () => number;
  private id: () => string;
  private after: typeof nodeScheduler.after;
  private onRevoke: (id: string) => void;
  constructor(
    now: () => number,
    id: () => string = randomUUID,
    after = nodeScheduler.after,
    onRevoke: (id: string) => void = () => {},
  ) {
    this.now = now;
    this.id = id;
    this.after = after;
    this.onRevoke = onRevoke;
  }
  enroll(scope: "read" | "operate", ttlMs: number, project?: WorkspaceId) {
    const expiresAt = this.now() + ttlMs;
    return this.issue(scope, expiresAt, (id) => this.after(ttlMs, () => this.revoke(id)), project);
  }
  /**
   * A lease for a process the daemon runs (ADR 0117): no expiry, because its holder lives as long
   * as the daemon lets it; the daemon revokes it when the process stops, and restart ends it.
   */
  enrollHeld(holder: "spade", scope: "read" | "operate") {
    return this.issue(scope, Number.MAX_SAFE_INTEGER, () => () => {}, undefined, holder);
  }
  private issue(
    scope: "read" | "operate",
    expiresAt: number,
    schedule: (id: string) => () => void,
    project?: WorkspaceId,
    holder?: "spade",
  ) {
    const id = this.id();
    const lease = this.credentials.issue(
      {
        sessionId: id,
        threadId: ThreadId.parse(`external:${id}`),
        agentId: AgentId.parse(`external:${id}`),
        capabilities: scope === "operate" ? ["thread_control", "agents"] : [],
      },
      new AbortController().signal,
    );
    const entry = {
      id,
      scope,
      ...(project ? { project } : {}),
      ...(holder ? { holder } : {}),
      expiresAt,
      end: lease.end,
      cancel: schedule(id),
    };
    this.entries.set(id, entry);
    return { id, scope, project, expiresAt: entry.expiresAt, bearer: lease.bearer };
  }
  caller(caller: McpAttribution): Enrollment {
    const entry = this.entries.get(caller.sessionId);
    if (!entry || entry.expiresAt <= this.now()) throw new Error("Enrollment expired");
    return entry;
  }
  list(): Enrollment[] {
    return [...this.entries.values()]
      .filter((entry) => entry.expiresAt > this.now())
      .map(({ end: _end, cancel: _cancel, ...entry }) => entry);
  }
  revoke(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    entry.cancel();
    entry.end();
    this.onRevoke(id);
    return true;
  }
  close(): void {
    for (const id of this.entries.keys()) this.revoke(id);
    this.credentials.close();
  }
}
