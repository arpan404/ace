import { z } from "zod";

const ResultText = z.string().max(256 * 1024);

// Only primitive string operations participate in the renderer's byte guard.
// Page code may replace JSON.stringify, TextEncoder or prototype methods. It
// cannot change indexed string access/comparison, or the daemon's JSON parser.
export const serializeEvaluationValue = String.raw`value => {
  const text = JSON.stringify(value ?? null);
  if (typeof text !== 'string') throw new Error('invalid evaluation serialization');
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c <= '\u007f') bytes++;
    else if (c <= '\u07ff') bytes += 2;
    else if (c >= '\ud800' && c <= '\udbff' &&
             text[i + 1] >= '\udc00' && text[i + 1] <= '\udfff') {
      bytes += 4; i++;
    } else bytes += 3;
    if (bytes > 262144) throw new Error('evaluate result exceeds limit');
  }
  return text;
}`;

/** Decode only bounded serialized JSON at the trusted daemon boundary. */
export function decodeEvaluationValue(raw: unknown): unknown {
  const text = ResultText.parse(raw);
  if (Buffer.byteLength(text, "utf8") > 256 * 1024) throw new Error("Oversized evaluation");
  const value: unknown = JSON.parse(text);
  return value;
}
