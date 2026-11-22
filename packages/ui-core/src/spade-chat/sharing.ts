import { z } from "zod";

/*
 * Spade on an org host (ADR 0206 §2.3, §4.2), as every client reads it: the organization the
 * machine's Spade belongs to (`GET /v1/org`) and a shared bot's access list
 * (`GET /v1/agents/{id}/access`). A personal machine's Spade belongs to no organization.
 */

export const SpadeOrgView = z.object({
  org: z.string().max(128).nullable(),
  name: z.string().max(256).optional(),
  host: z.string().max(128).optional(),
  policy: z.number().int().nonnegative().optional(),
  auditKey: z.string().max(128).nullable().optional(),
});
export type SpadeOrgView = z.infer<typeof SpadeOrgView>;

export const SpadeSharedAccess = z.object({
  org: z.string().max(128),
  maker: z.string().max(256),
  /** Undefined: every member may talk to it. */
  talk: z.array(z.string().max(256)).max(200).optional(),
  approvers: z.array(z.string().max(256)).max(200),
  configurers: z.array(z.string().max(256)).max(200).optional(),
});
export type SpadeSharedAccess = z.infer<typeof SpadeSharedAccess>;

/** `GET /v1/org`'s answer. */
export const spadeOrgView = (text: string): SpadeOrgView => SpadeOrgView.parse(JSON.parse(text));

/** `GET /v1/agents/{id}/access`'s answer. */
export const spadeSharedAccess = (text: string): SpadeSharedAccess =>
  z.object({ access: SpadeSharedAccess }).parse(JSON.parse(text)).access;

/** The word beside a shared bot's name, and the line under it on its page. */
export const sharedWord = "Shared";
export const sharedInLine = (orgName: string | undefined): string =>
  `Shared in ${orgName || "your organization"}`;
