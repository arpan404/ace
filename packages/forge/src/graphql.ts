import { z } from "zod";
import { ForgeError } from "./errors.ts";

const envelope = z.looseObject({
  errors: z
    .array(
      z.looseObject({
        type: z.string().max(65_536).optional(),
        message: z.string().max(65_536).optional(),
      }),
    )
    .max(100)
    .optional(),
});

/** Reject GraphQL failures, including partial data, before interpreting the CLI exit code. */
export function checkedGraphql(body: unknown): unknown {
  const parsed = envelope.safeParse(body);
  if (!parsed.success) throw new ForgeError("invalid_data");
  if (parsed.data.errors?.length) {
    const types = new Set(parsed.data.errors.map((error) => error.type));
    if (types.has("RATE_LIMITED")) throw new ForgeError("rate_limit");
    if (types.has("FORBIDDEN") || types.has("UNAUTHORIZED")) throw new ForgeError("forbidden");
    if (types.has("NOT_FOUND")) throw new ForgeError("not_found");
    throw new ForgeError("unsupported");
  }
  return body;
}
