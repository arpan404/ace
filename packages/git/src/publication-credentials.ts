import { sensitiveSpans, isSecretKey } from "@ace/redaction";
import { z } from "zod";
import { GitError } from "./types.ts";

const fields = z.record(z.string(), z.unknown());
const elements = z.array(z.unknown());
const credentialKey =
  /^(?:_?auth(?:token)?|private[_-]?key|(?:aws[_-]?)?access[_-]?key(?:[_-]?id)?)$/i;

/** Parse structured fields too: escaped keys and base64 Docker auth need no token signature. */
function containsStructuredCredential(text: string): boolean {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return false;
  }
  const pending: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let entries = 0;
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    if (next.depth > 64 || entries > 100000)
      throw new GitError("publication_scan_incomplete", "Structured credential scan incomplete");
    if (Array.isArray(next.value)) {
      const values = elements.parse(next.value);
      entries += values.length;
      if (entries > 100000)
        throw new GitError("publication_scan_incomplete", "Structured credential scan incomplete");
      for (const value of values) pending.push({ value, depth: next.depth + 1 });
    } else if (next.value !== null && typeof next.value === "object") {
      for (const [key, value] of Object.entries(fields.parse(next.value))) {
        if (++entries > 100000)
          throw new GitError(
            "publication_scan_incomplete",
            "Structured credential scan incomplete",
          );
        if (
          (isSecretKey(key) || credentialKey.test(key)) &&
          typeof value === "string" &&
          value.trim()
        )
          return true;
        pending.push({ value, depth: next.depth + 1 });
      }
    }
  }
  return false;
}

/** Shared redaction signatures plus credential formats that intentionally hide their value shape. */
export function containsPublicationCredential(text: string): boolean {
  return (
    sensitiveSpans(text).next().done === false ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text) ||
    /(?:https?|ssh):\/\/[^\s/@:]+:[^\s/@]+@/i.test(text) ||
    /(?:^|[\s:/])(?:_auth(?:Token)?|private[_-]?key|(?:aws[_-]?)?access[_-]?key(?:[_-]?id)?)\s*[:=]\s*["']?[^\s"'#,;]+/im.test(
      text,
    ) ||
    containsStructuredCredential(text)
  );
}
