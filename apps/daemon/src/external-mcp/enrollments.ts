import { randomBytes, randomUUID } from "node:crypto";
import { CredentialRegistry, nodeScheduler, type SessionLease } from "@ace/mcp-server";
import { AgentId, ThreadId, type WorkspaceId, type McpAttribution } from "@ace/protocol";
export interface Enrollment {
  id: string;
  scope: "read" | "operate";
  project?: WorkspaceId;
  expiresAt: number;
}
export class Enrollments {
  readonly credentials = new CredentialRegistry(() => randomBytes(32).toString("hex"), 64);
  private entries = new Map<string, Enrollment & { end: SessionLease["end"]; cancel(): void }>();
  private now: () => number;
  private id: () => string;
  private after: typeof nodeScheduler.after;
  constructor(now: () => number, id: () => string = randomUUID, after = nodeScheduler.after) {
    this.now = now;
    this.id = id;
    this.after = after;
  }
  enroll(scope: "read" | "operate", ttlMs: number, project?: WorkspaceId) {
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
      expiresAt: this.now() + ttlMs,
      end: lease.end,
      cancel: this.after(ttlMs, () => this.revoke(id)),
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
    return true;
  }
  close(): void {
    for (const id of this.entries.keys()) this.revoke(id);
    this.credentials.close();
  }
}
