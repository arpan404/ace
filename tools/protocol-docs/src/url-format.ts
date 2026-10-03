/* oxlint-disable eslint/no-underscore-dangle -- Zod exposes typed checks through its _zod API. */
import type { z } from "zod";

export const urlFormat = "ace-whatwg-url";
export const urlConstraint =
  "Accept strings whose trimmed value is an absolute WHATWG URL. Whitespace, Unicode hosts, opaque schemes and parser-normalized URLs are allowed. x-ace-url-minLength and x-ace-url-maxLength apply after trimming whitespace and removing ASCII tab, CR and LF characters, using UTF-16 code units. Install the ace-whatwg-url format validator or enforce this rule in application code.";

export function hasUrlCheck(schema: z.core.$ZodType): boolean {
  const def = schema._zod.def;
  return (
    ("format" in def && def.format === "url") ||
    Boolean(
      def.checks?.some((check) => "format" in check._zod.def && check._zod.def.format === "url"),
    )
  );
}

/** Native URI format uses different acceptance rules from Zod's WHATWG parser. */
export const preserveUrl: NonNullable<z.core.ToJSONSchemaParams["override"]> = ({
  zodSchema,
  jsonSchema,
}) => {
  if (hasUrlCheck(zodSchema)) {
    jsonSchema.format = urlFormat;
    if (jsonSchema.minLength !== undefined) {
      jsonSchema["x-ace-url-minLength"] = jsonSchema.minLength;
      delete jsonSchema.minLength;
    }
    if (jsonSchema.maxLength !== undefined) {
      jsonSchema["x-ace-url-maxLength"] = jsonSchema.maxLength;
      delete jsonSchema.maxLength;
    }
    jsonSchema["x-ace-constraint"] = urlConstraint;
  }
};

export function acceptsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).href.length > 0;
  } catch {
    return false;
  }
}

export function urlLength(value: string): number {
  return value.trim().replaceAll("\t", "").replaceAll("\r", "").replaceAll("\n", "").length;
}
