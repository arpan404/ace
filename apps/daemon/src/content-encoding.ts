export type ContentEncoding = "br" | "gzip";

const qvalue = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * The response coding an `Accept-Encoding` header allows, brotli first. A `q=0` or malformed
 * q-value refuses a coding; `*` covers codings without their own entry. Undefined is identity.
 */
export function negotiateContentEncoding(header: string | undefined): ContentEncoding | undefined {
  const accepted = new Map<string, boolean>();
  for (const part of header?.split(",") ?? []) {
    const [name = "", ...parameters] = part.split(";").map((piece) => piece.trim().toLowerCase());
    const q = parameters.find((parameter) => parameter.startsWith("q="))?.slice(2);
    if (name && !accepted.has(name))
      accepted.set(name, q === undefined || (qvalue.test(q) && Number(q) > 0));
  }
  const allows = (coding: string) => accepted.get(coding) ?? accepted.get("*") ?? false;
  return allows("br") ? "br" : allows("gzip") ? "gzip" : undefined;
}
