import { z } from "zod";

/*
 * What an org host's daemon keeps true of its Spade (ADR 0206 §2.1, §3, §4.3), as pure rules:
 * Spade belongs to the organization the machine answers to, and to nothing once released; it
 * holds the organization's newest policy; and its audit outbox reaches the backend in order.
 */

/** Spade's `GET /v1/org`, read leniently: an unbound Spade answers `{org: null}`. */
export const SpadeOrgView = z.object({
  org: z.string().nullable().catch(null),
  name: z.string().optional().catch(undefined),
  host: z.string().optional().catch(undefined),
  policy: z.number().int().nonnegative().optional().catch(undefined),
});
export type SpadeOrgView = z.infer<typeof SpadeOrgView>;

/** The organization Spade should belong to: this host's, its name and the host's id. */
export interface WantedBinding {
  org: string;
  name: string;
  host: string;
}

export type BindingStep = "unbind" | "bind";

/**
 * What to change so Spade belongs to `wanted` (or to nothing): Spade refuses a binding to
 * another organization while it holds one, so that one is let go first. A binding to the same
 * organization under another name or host id is written again in place.
 */
export function bindingSteps(view: SpadeOrgView, wanted: WantedBinding | undefined): BindingStep[] {
  if (!wanted) return view.org ? ["unbind"] : [];
  if (view.org && view.org !== wanted.org) return ["unbind", "bind"];
  if (view.org === wanted.org && view.name === wanted.name && view.host === wanted.host) return [];
  return ["bind"];
}

/** Whether a policy version the backend serves is one Spade would take: newer and signed. */
export function newerPolicy(
  held: number | undefined,
  offered: { version: number; statement?: string | undefined },
): boolean {
  return offered.statement !== undefined && offered.version > (held ?? 0);
}

/** One outbox entry as Spade serves it: what `POST /v1/orgs/{org}/audit` takes, and its place. */
export const OutboxEntry = z.looseObject({
  seq: z.number().int(),
  hash: z.string(),
});
export const Outbox = z.object({ entries: z.array(OutboxEntry) });

/**
 * How a forwarded entry went: `taken` (stored, or a replay the backend already holds),
 * `refused` (WorkOS will never take it: it stays in the host's own log and the outbox moves on)
 * or `retry` (offline, or the backend failed: the outbox stops here and tries again later).
 */
export type Forwarded = "taken" | "refused" | "retry";

export function forwardedAs(status: number): Forwarded {
  if (status >= 200 && status < 300) return "taken";
  // The backend's word that retrying can't help (`audit_refused`), or an entry it can't read.
  if (status === 422 || status === 400) return "refused";
  return "retry";
}

/** The entry an outbox read sends on: what the backend's schema has, without Spade's `seq`. */
export function outgoingEntry(entry: z.infer<typeof OutboxEntry>): Record<string, unknown> {
  const { seq: _seq, ...rest } = entry;
  return rest;
}
