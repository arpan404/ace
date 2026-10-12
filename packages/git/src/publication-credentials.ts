import { sensitiveSpans, isSecretKey } from "@ace/redaction";
import { z } from "zod";
import { isScalar, parseDocument } from "yaml";
import { GitError } from "./types.ts";
import { publicationAssignmentKeys } from "./publication-assignment-keys.ts";

const fields = z.record(z.string(), z.unknown());
const elements = z.array(z.unknown());
const credentialKey =
  /^(?:_?auth(?:token)?|private[_-]?key|(?:aws[_-]?)?access[_-]?key(?:[_-]?id)?|client-key-data|client-certificate-data|auth-provider)$/i;
// These describe credential policy or location, rather than carrying its value.
const policySuffix =
  /[_-](?:(?:min|max)[_-])?(?:length|age)$|[_-](?:url|endpoint|path|file|expiry|expiration|ttl|expires[_-]at|timeout|enabled|required|policy|pattern|algorithm|encoding|format)$/i;

/** Credential field names are shared by assignment, JSON and YAML inspection. */
export function isPublicationCredentialKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  if (policySuffix.test(words)) return false;
  return isSecretKey(key) || credentialKey.test(key);
}
function assignmentKey(part: string): string {
  if (part[0] !== '"' && part[0] !== "'") return part;
  try {
    // TOML basic/literal quoted keys use the same scalar escapes as YAML.
    const document = parseDocument(part, { strict: true, prettyErrors: false, logLevel: "silent" });
    if (
      !document.errors.length &&
      !document.warnings.length &&
      isScalar(document.contents) &&
      typeof document.contents.value === "string"
    )
      return document.contents.value;
  } catch {
    /* Only a fixed inspection failure leaves this boundary. */
  }
  throw new GitError("publication_scan_incomplete", "Assignment key scan incomplete");
}
/** Inspect complete field names, rather than looking for a credential-name word boundary. */
function containsAssignmentCredential(text: string): boolean {
  for (const parts of publicationAssignmentKeys(text)) {
    // Dotted keys name containers before their final field, just as JSON does.
    const decoded = parts.map(assignmentKey).at(-1);
    if (decoded === undefined) continue;
    // Registry-scoped npm fields retain their complete leaf identifier.
    const key = decoded.split(/[/:]/).at(-1) ?? decoded;
    if (isPublicationCredentialKey(key)) return true;
  }
  return false;
}

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
        if (isPublicationCredentialKey(key) && typeof value === "string" && value.trim())
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
    containsAssignmentCredential(text) ||
    containsStructuredCredential(text)
  );
}
