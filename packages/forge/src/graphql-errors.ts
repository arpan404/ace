import { z } from "zod";
import { ForgeError } from "./errors.ts";
const Response = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z
    .array(
      z.looseObject({
        type: z.string().optional(),
        extensions: z.looseObject({ code: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});
/** Partial GraphQL results cannot establish rejection of a mutation. */
export function assertGraphqlResult(body: unknown): void {
  const parsed = Response.safeParse(body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  const { data, errors } = parsed.data;
  if (!errors?.length) return;
  const rejected = !data || Object.values(data).every((value) => value === null);
  const codes = errors.map((error) => error.type ?? error.extensions?.code);
  if (rejected && codes.every((code) => code === "RATE_LIMITED"))
    throw new ForgeError("rate_limit", undefined, false);
  if (rejected && codes.every((code) => code === "FORBIDDEN" || code === "UNAUTHORIZED"))
    throw new ForgeError("forbidden", undefined, false);
  if (rejected && codes.every((code) => code === "NOT_FOUND"))
    throw new ForgeError("not_found", undefined, false);
  if (rejected && codes.every((code) => code === "GRAPHQL_VALIDATION_FAILED"))
    throw new ForgeError("invalid_data", undefined, false);
  throw new ForgeError("invalid_data");
}
