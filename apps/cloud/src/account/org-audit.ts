import type { AceOrgAuditEntry } from "@ace/protocol/ace-org";
import { digest } from "./crypto.ts";
import type { WorkosOrgs } from "./workos-orgs.ts";

type Ref = { type: string; id: string; name?: string | undefined };

/** Where an action came from, as WorkOS Audit Logs records it: the caller's address. */
function context(request: Request) {
  return {
    location: request.headers.get("CF-Connecting-IP") ?? "0.0.0.0",
    user_agent: (request.headers.get("User-Agent") ?? "").slice(0, 256),
  };
}

/**
 * The organization's WorkOS Audit Logs copy (ADR 0206 §4.3). The backend writes its own events
 * (membership, policy, invitations, hosts, portal links) and forwards org hosts' entries, each
 * with an idempotency key, so a retry or a replay after a restart never writes one twice.
 */
export function orgAudit(deps: { workos: Pick<WorkosOrgs, "createAuditEvent">; now: () => number }) {
  return {
    /**
     * One of the backend's own events. The action already happened at WorkOS, so a failure here
     * is logged, not passed on.
     */
    async record(
      request: Request,
      org: string,
      event: { action: string; actor: Ref; targets: Ref[]; metadata?: Record<string, string> },
    ): Promise<void> {
      const occurredAt = new Date(deps.now()).toISOString();
      const key = await digest(
        JSON.stringify([org, event.action, event.actor.id, event.targets, event.metadata, occurredAt]),
      );
      try {
        await deps.workos.createAuditEvent(
          org,
          {
            action: event.action,
            occurred_at: occurredAt,
            actor: event.actor,
            targets: event.targets,
            context: context(request),
            ...(event.metadata ? { metadata: event.metadata } : {}),
          },
          key,
        );
      } catch {
        console.warn(JSON.stringify({ event: "org_audit_unwritten", action: event.action }));
      }
    },
    /** One org host's log entry, keyed by its chain hash. Failures reach the host, which retries. */
    forward: (request: Request, org: string, entry: AceOrgAuditEntry) =>
      deps.workos.createAuditEvent(
        org,
        {
          action: entry.action,
          occurred_at: new Date(entry.occurredAt).toISOString(),
          ...(entry.version ? { version: entry.version } : {}),
          actor: entry.actor,
          targets: entry.targets,
          context: context(request),
          metadata: { ...entry.metadata, entry_sha256: entry.hash },
        },
        entry.hash,
      ),
  };
}
export type OrgAudit = ReturnType<typeof orgAudit>;
