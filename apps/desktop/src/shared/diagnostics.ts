import { z } from "zod";

/** A field the page reports: short text, a finite number, a flag or null. */
const ReportValue = z.union([z.string().max(1_024), z.number(), z.boolean(), z.null()]);

/**
 * One diagnostic event from the page for the desktop log (`ace.diagnostics.report`): a short
 * event name and a few flat fields. Bounded so a page cannot write large records.
 */
export const DiagnosticReport = z.strictObject({
  event: z.string().min(1).max(128),
  data: z
    .record(z.string().min(1).max(64), ReportValue)
    .refine((fields) => Object.keys(fields).length <= 24, "At most 24 fields")
    .optional(),
});
export type DiagnosticReport = z.output<typeof DiagnosticReport>;
