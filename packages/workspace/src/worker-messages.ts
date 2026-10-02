import { z } from "zod";
export const workerRequest = z.object({
  text: z.string().max(3 * 16 * 1024 * 1024),
  path: z.string(),
  source: z.string().max(16_384),
  caseSensitive: z.boolean(),
  limit: z.number().int().min(1).max(10_000),
  lineOffset: z.number().int().nonnegative(),
});
export const workerResponse = z.union([
  z.object({
    matches: z
      .array(
        z.object({
          path: z.string(),
          line: z.number().int().positive(),
          column: z.number().int().positive(),
          preview: z.string().max(512),
        }),
      )
      .max(10_000),
  }),
  z.object({ error: z.string() }),
]);

export const workerStarted = z.object({ type: z.literal("started") });
