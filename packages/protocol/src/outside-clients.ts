import { z } from "zod";
import { ThreadId, WorkspaceId } from "./ids.ts";

/**
 * MCP clients outside ace (ADR 0117): what a grant lets one do on this machine. Each scope is
 * its own tick when the person approves; `threads:read` is always included.
 */
export const OutsideScope = z.enum([
  "threads:read",
  "threads:start",
  "threads:message",
  "threads:stop",
  "browser",
  "computer",
]);
export type OutsideScope = z.infer<typeof OutsideScope>;

/** How the client was registered: `ace mcp enroll`, a metadata document URL, or DCR. */
export const OutsideClientKind = z.enum(["cli", "cimd", "dcr"]);
export type OutsideClientKind = z.infer<typeof OutsideClientKind>;

const grantId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const timestamp = z.number().int().nonnegative();
const scopes = z.array(OutsideScope).min(1).max(OutsideScope.options.length);
/** Every project, or only these. */
export const OutsideProjects = z.union([z.literal("all"), z.array(WorkspaceId).min(1).max(256)]);
export type OutsideProjects = z.infer<typeof OutsideProjects>;

/** One outside grant as an admin device sees it. Never carries a token. */
export const OutsideGrant = z.object({
  id: grantId,
  clientKind: OutsideClientKind,
  clientId: z.string().min(1).max(2048),
  name: z.string().min(1).max(256),
  /** The client's verified domain; null when it is unverified (DCR, CLI). */
  domain: z.string().min(1).max(253).nullable(),
  scopes,
  projects: OutsideProjects,
  createdAt: timestamp,
  /** Null: until revoked. */
  expiresAt: timestamp.nullable(),
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
  /** The admin device that approved it, or `local` for `ace mcp enroll`. */
  approvedBy: z.string().min(1).max(256),
});
export type OutsideGrant = z.infer<typeof OutsideGrant>;

/** Who started a thread when an outside client did, beside `startedBy` for agents. */
export const StartedByClient = z.object({
  kind: z.literal("mcp_client"),
  grantId,
  name: z.string().min(1).max(256),
});
export type StartedByClient = z.infer<typeof StartedByClient>;

/**
 * A client asking to sign in (or for more access), sent to admin devices. The person checks the
 * match code against the one the client's sign-in page shows.
 */
export const OutsideAccessRequest = z.object({
  requestId: z.string().min(1).max(128),
  clientName: z.string().min(1).max(256),
  /** Null: the client's domain is unverified. */
  domain: z.string().min(1).max(253).nullable(),
  scopes,
  matchCode: z.string().min(4).max(16),
  expiresAt: timestamp,
  /** Set when an existing grant asks for more access (step-up). */
  grantId: grantId.optional(),
});
export type OutsideAccessRequest = z.infer<typeof OutsideAccessRequest>;

/** What the person chose for an access request. */
export const OutsideAccessDecision = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    scopes,
    projects: OutsideProjects,
    /** Null: until revoked. */
    expiresAt: timestamp.nullable(),
  }),
  z.object({ decision: z.literal("deny") }),
]);
export type OutsideAccessDecision = z.infer<typeof OutsideAccessDecision>;

/** An outside client using this machine's screen now ("Claude is using this Mac"). */
export const OutsideScreenUse = z.object({
  grantId,
  name: z.string().min(1).max(256),
  apps: z.array(z.string().max(256)).max(16),
});
export type OutsideScreenUse = z.infer<typeof OutsideScreenUse>;

/** One way outside clients reach this machine (ADR 0117, Reach). */
export const OutsideEndpoint = z.object({
  path: z.enum(["local", "tailscale", "relay", "custom"]),
  /** The URL to paste into a client; null while this path is off or can't serve. */
  url: z.url().max(2048).nullable(),
  on: z.boolean(),
  /** Why an on path can't serve right now (signed out, no ts.net certificate, ...). */
  problem: z.string().min(1).max(512).optional(),
});
export type OutsideEndpoint = z.infer<typeof OutsideEndpoint>;

const OutsideOperation = z.discriminatedUnion("op", [
  /** Every grant, revoked ones included, with the threads each started or messaged. */
  z.object({ op: z.literal("grants") }),
  z.object({ op: z.literal("revoke"), grantId }),
  /** Change what a live grant allows; omitted fields keep their value. */
  z.object({
    op: z.literal("update"),
    grantId,
    scopes: scopes.optional(),
    projects: OutsideProjects.optional(),
    expiresAt: timestamp.nullable().optional(),
  }),
  /** Pending access requests and screen use, now and on every change (`outside.state`). */
  z.object({ op: z.literal("watch") }),
  /** The addresses outside clients can use, best first. */
  z.object({ op: z.literal("endpoints") }),
  /** End an outside client's screen work at once. */
  z.object({ op: z.literal("stopScreen"), grantId }),
  z.object({
    op: z.literal("decide"),
    accessRequestId: OutsideAccessRequest.shape.requestId,
    choice: OutsideAccessDecision,
  }),
]);
export type OutsideOperation = z.infer<typeof OutsideOperation>;

/** Outside MCP clients' grants on this machine. Admin devices only. */
export const OutsideRequest = z.object({
  type: z.literal("outside.request"),
  requestId: z.string().min(1).max(128),
  operation: OutsideOperation,
});
export type OutsideRequest = z.infer<typeof OutsideRequest>;

export const OutsideGrantEntry = OutsideGrant.extend({
  /** Threads the grant started, newest first. */
  started: z.array(ThreadId).max(256),
  /** Threads the grant sent messages to, newest first. */
  messaged: z.array(ThreadId).max(256),
});
export type OutsideGrantEntry = z.infer<typeof OutsideGrantEntry>;

const OutsideOutcome = z.discriminatedUnion("kind", [
  // Every live grant, and the most recent ended ones.
  z.object({ kind: z.literal("grants"), grants: z.array(OutsideGrantEntry).max(20_000) }),
  z.object({ kind: z.literal("revoked") }),
  z.object({ kind: z.literal("updated"), grant: OutsideGrant }),
  z.object({ kind: z.literal("watching") }),
  z.object({ kind: z.literal("screenStopped") }),
  z.object({ kind: z.literal("decided") }),
  z.object({ kind: z.literal("endpoints"), endpoints: z.array(OutsideEndpoint).max(8) }),
]);
export type OutsideOutcome = z.infer<typeof OutsideOutcome>;

export const OutsideResult = z.object({
  type: z.literal("outside.result"),
  requestId: z.string().min(1).max(128),
  result: OutsideOutcome,
});
export type OutsideResult = z.infer<typeof OutsideResult>;

/** Pushed to a watching admin device: pending access requests and outside screen use. */
export const OutsideState = z.object({
  type: z.literal("outside.state"),
  access: z.array(OutsideAccessRequest).max(64),
  screen: z.array(OutsideScreenUse).max(64),
});
export type OutsideState = z.infer<typeof OutsideState>;
