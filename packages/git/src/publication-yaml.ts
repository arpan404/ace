import { isSecretKey, sensitiveSpans } from "@ace/redaction";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import { GitError } from "./types.ts";

const tags = new Set(
  ["str", "int", "float", "bool", "null", "map", "seq"].map((tag) => `tag:yaml.org,2002:${tag}`),
);
const kubeCredential = /^(?:client-key-data|client-certificate-data|auth-provider)$/i;
function incomplete(): never {
  throw new GitError("publication_scan_incomplete", "YAML credential scan incomplete");
}
function populated(value: unknown): boolean {
  if (value === null) return false;
  if (isScalar(value))
    return value.value !== null && value.value !== undefined && value.value !== "";
  if (isMap(value) || isSeq(value)) return value.items.length > 0;
  return incomplete();
}

/** Walk parsed nodes without converting or expanding aliases. Never emit parser diagnostics. */
export function assertPublicationYaml(bytes: Buffer): void {
  if (bytes.length > 1024 * 1024) incomplete();
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(new TextDecoder("utf8", { fatal: true }).decode(bytes), {
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      prettyErrors: false,
      logLevel: "silent",
    });
  } catch {
    return incomplete();
  }
  if (documents.length > 20 || documents.some((doc) => doc.errors.length || doc.warnings.length))
    incomplete();
  const pending: { value: unknown; depth: number }[] = documents.map((doc) => ({
    value: doc.contents,
    depth: 0,
  }));
  let entries = 0;
  const enqueue = (value: unknown, depth: number) => {
    if (++entries > 100000 || depth > 64) incomplete();
    pending.push({ value, depth });
  };
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    const value = next.value;
    if (value === null) continue;
    if (isAlias(value)) incomplete();
    if ((isMap(value) || isSeq(value) || isScalar(value)) && value.tag && !tags.has(value.tag))
      incomplete();
    if (isMap(value)) {
      for (const pair of value.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") incomplete();
        const key = pair.key.value;
        if ((isSecretKey(key) || kubeCredential.test(key)) && populated(pair.value))
          throw new GitError("sensitive_publication", "Sensitive YAML credential field");
        if (
          key.toLowerCase() === "exec" &&
          isMap(pair.value) &&
          pair.value.items.some(
            (item) => isScalar(item.key) && item.key.value === "env" && populated(item.value),
          )
        )
          throw new GitError("sensitive_publication", "Sensitive YAML exec environment");
        enqueue(pair.value, next.depth + 1);
      }
    } else if (isSeq(value)) {
      for (const item of value.items) enqueue(item, next.depth + 1);
    } else if (isScalar(value)) {
      if (typeof value.value === "string" && sensitiveSpans(value.value).next().done === false)
        throw new GitError("sensitive_publication", "Sensitive YAML scalar");
    } else incomplete();
  }
}
