import { z } from "zod";

export const LIST_PAGE_SIZE = 100;
export const LIST_MAX_ITEMS = 1000;
export const LIST_MAX_STEPS = 10;
export const FILES_PAGE_SIZE = 100;
export const FILES_MAX_ITEMS = 1000;
export const FILES_MAX_STEPS = 40;
export const ROW_PAGE_SIZE = 25;

/** A public actor as GET /repos/{owner}/{repo}/pulls[:/{n}] reports it.
 * cursor.com/docs/api/origin/reference/list-pull-requests and
 * cursor.com/docs/api/origin/reference/get-pull-request; unknown fields stay via passthrough. */
export const OriginAuthor = z
  .object({
    user: z
      .looseObject({
        id: z.string(),
        email: z.string().optional(),
        handle: z.string().optional(),
        displayName: z.string().optional(),
      })
      .optional(),
    app: z.looseObject({ id: z.string(), displayName: z.string().optional() }).optional(),
    serviceAccount: z
      .looseObject({
        id: z.string(),
        type: z.string().optional(),
        displayName: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

/** One pull request snapshot; numbers and version numbers are JSON strings. Text fields have
 * no length bound here: readers cut them to the protocol's, so one long record never fails a
 * whole read (the response is bounded by its ReadBudget).
 * cursor.com/docs/api/origin/reference/get-pull-request; unknown fields stay via passthrough. */
export const OriginPr = z
  .object({
    number: z.union([z.string().max(32), z.number()]),
    state: z.string().max(32),
    merged: z.boolean(),
    draft: z.boolean(),
    title: z.string(),
    body: z.string().optional(),
    head: z.looseObject({ ref: z.string(), sha: z.string().max(256) }),
    base: z.looseObject({ ref: z.string(), sha: z.string().max(256) }),
    author: OriginAuthor.optional(),
    createdAt: z.string().min(1).max(65_536),
    updatedAt: z.string().min(1).max(65_536),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    changedFiles: z.number().int().nonnegative().optional(),
    labels: z.array(z.looseObject({ name: z.string(), color: z.string().optional() })).optional(),
    webUrl: z.string().max(4096).optional(),
    version: z
      .looseObject({
        number: z.union([z.string().max(32), z.number()]).optional(),
        headSha: z.string().max(256).optional(),
        baseSha: z.string().max(256).optional(),
      })
      .optional(),
  })
  .passthrough();
export type OriginPr = z.infer<typeof OriginPr>;

/** List envelope: page of snapshots plus an opaque cursor.
 * cursor.com/docs/api/origin/reference/list-pull-requests and
 * cursor.com/docs/api/origin/reference/pagination (no totals). The docs guarantee
 * nextPageToken, empty when done, but the published examples omit the field, so a
 * missing or blank token ends the traversal. */
export const OriginPrList = z
  .looseObject({
    pullRequests: z.array(OriginPr).max(100),
    nextPageToken: z.string().max(8192).optional(),
  })
  .passthrough();

/** One changed file as GET .../pulls/{n}/files reports it.
 * cursor.com/docs/api/origin/reference/list-pull-request-files. */
export const OriginFile = z
  .object({
    filename: z.string(),
    status: z.string().max(64),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    patch: z.string().optional(),
    previousFilename: z.string().optional(),
  })
  .passthrough();
export type OriginFile = z.infer<typeof OriginFile>;
export const OriginFilesPage = z
  .looseObject({
    files: z.array(OriginFile).max(100),
    nextPageToken: z.string().max(8192).optional(),
  })
  .passthrough();

/** Google RPC-style error body; cursor.com/docs/api/origin/reference/errors. */
export const OriginError = z
  .looseObject({ code: z.number().optional(), message: z.string().max(4096).optional() })
  .passthrough();

export type OriginPrState = "open" | "draft" | "closed" | "merged";
/** Unknown is separate: an unrecognized lifecycle state must never read as open. */
export type OriginLifecycle = OriginPrState | "unknown";

/** A decimal-string number as Origin encodes it; null when not a safe positive int. */
export function safeNumber(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d{1,15}$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function stateOf(pr: OriginPr): OriginLifecycle {
  if (pr.merged === true) return "merged";
  const state = pr.state.toLowerCase();
  if (state === "closed") return "closed";
  if (state === "open") return pr.draft === true ? "draft" : "open";
  return "unknown";
}

export function authorOf(pr: OriginPr): string {
  const user = pr.author?.user;
  if (user) {
    if (user.handle?.trim()) return user.handle;
    if (user.displayName?.trim()) return user.displayName;
    if (user.email?.trim()) return user.email;
    if (user.id.trim()) return user.id;
  }
  const app = pr.author?.app;
  if (app) return app.displayName?.trim() ? app.displayName : app.id;
  const service = pr.author?.serviceAccount;
  if (service) {
    if (service.displayName?.trim()) return service.displayName;
    if (service.type?.trim()) return service.type;
    return service.id;
  }
  return "deleted user";
}

export function lowerSha(value: string): string | null {
  const lower = value.toLowerCase();
  return /^[a-f0-9]{40,64}$/.test(lower) ? lower : null;
}
