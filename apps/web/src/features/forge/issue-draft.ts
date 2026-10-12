import * as z from "zod/mini";

export const IssueDraft = z.object({
  title: z.string(),
  body: z.string(),
  updatedAt: z.optional(z.string()),
  revision: z.optional(z.string()),
  submission: z.optional(z.object({ id: z.string(), revision: z.string() })),
});
export type IssueDraft = z.infer<typeof IssueDraft>;

/** A confirmed submission only consumes the revision that was sent. */
export function confirmIssueDraft(draft: IssueDraft, id: string): IssueDraft | undefined {
  if (draft.submission?.id !== id) return draft;
  if (draft.revision === draft.submission.revision) return undefined;
  return { ...draft, submission: undefined };
}
