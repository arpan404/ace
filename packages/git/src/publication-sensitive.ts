import { sensitiveSpans } from "@ace/redaction";
import { decode, hashSchema, count } from "./decode.ts";
import { z } from "zod";
import { GitError } from "./types.ts";
import { containsPublicationCredential } from "./publication-credentials.ts";
import { assertPublicationYaml } from "./publication-yaml.ts";

export function sensitivePublicationPath(path: string): boolean {
  if (sensitiveSpans(path).next().done === false) return true;
  return path
    .split("/")
    .some(
      (part) =>
        /^\.env/i.test(part) ||
        /kubeconfig/i.test(part) ||
        /^(?:\.ssh|\.gnupg|\.aws|\.azure|\.docker|\.kube|\.oci|\.gcloud|gcloud|\.boto|\.s3cfg|\.terraformrc|terraform\.rc|\.terraform\.d|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$/i.test(
          part,
        ) ||
        /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:[._-].*)?|.*[._-]credentials?(?:[._-].*)?|service[-_]account.*\.json|secrets?(?:[._-].*)?)$/i.test(
          part,
        ) ||
        /\.(?:pem|der|key|p12|pfx|jks|keystore)$/i.test(part),
    );
}
export function assertPublicationText(bytes: Buffer): void {
  const text = bytes.toString("utf8");
  if (containsPublicationCredential(text))
    throw new GitError("sensitive_publication", "Sensitive publication content");
  if (text.startsWith("version https://git-lfs.github.com/spec/v1")) incompletePublicationScan();
}
export function incompletePublicationScan(): never {
  throw new GitError("publication_scan_incomplete", "Publication safety scan incomplete");
}
export type PublicationReference = { id: string; format?: "yaml" };
export type ScanObject = PublicationReference & { type: "blob" | "tree" | "commit" | "tag"; size: number };
const objectType = z.enum(["blob", "tree", "commit", "tag"]);
export function objectHeader(line: string): ScanObject {
  const parts = /^(\S+) (\S+) (\d+)$/.exec(line);
  if (!parts) incompletePublicationScan();
  return {
    id: decode(hashSchema, parts[1], "publication object"),
    type: decode(objectType, parts[2], "publication object type"),
    size: count(parts[3]),
  };
}
/** Binary tree names are inspected independently of blobs, including reused/renamed content. */
export function assertPublicationTree(bytes: Buffer, hashBytes: number): PublicationReference[] {
  const children: PublicationReference[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset),
      end = bytes.indexOf(0, space + 1);
    if (space < offset || end < space || end + 1 + hashBytes > bytes.length)
      incompletePublicationScan();
    const name = new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(space + 1, end));
    if (sensitivePublicationPath(name))
      throw new GitError("sensitive_publication", "Sensitive publication path");
    const mode = bytes.subarray(offset, space).toString("ascii");
    if (mode !== "160000")
      children.push({
        id: bytes.subarray(end + 1, end + 1 + hashBytes).toString("hex"),
        ...(mode !== "40000" && mode !== "040000" && /\.ya?ml$/i.test(name) ? { format: "yaml" as const } : {}),
      });
    offset = end + 1 + hashBytes;
  }
  return children;
}
/** Parse the byte-framed batch result. Raw content never becomes diagnostics or a receipt. */
export function inspectPublicationBatch(bytes: Buffer, expected: readonly ScanObject[]): PublicationReference[] {
  const children: PublicationReference[] = [];
  let offset = 0;
  for (const object of expected) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) incompletePublicationScan();
    const actual = objectHeader(bytes.subarray(offset, end).toString("ascii"));
    if (actual.id !== object.id || actual.type !== object.type || actual.size !== object.size)
      incompletePublicationScan();
    offset = end + 1;
    const content = bytes.subarray(offset, offset + object.size);
    if (content.length !== object.size || bytes[offset + object.size] !== 10)
      incompletePublicationScan();
    if (object.type === "tree") {
      for (const id of assertPublicationTree(content, object.id.length / 2)) children.push(id);
    } else {
      if (object.type === "commit") {
        // Follow raw commit edges too, including roots reused from old remote snapshots.
        const endOfHeader = content.indexOf("\n\n");
        const headers = content.subarray(0, endOfHeader).toString("ascii").split("\n");
        const root = /^tree ([a-f0-9]+)$/.exec(headers[0] ?? "");
        if (endOfHeader < 0 || !root?.[1] || root[1].length !== object.id.length)
          incompletePublicationScan();
        children.push({ id: decode(hashSchema, root[1], "publication commit tree") });
        for (const header of headers.slice(1)) {
          if (!header.startsWith("parent ")) continue;
          const parent = /^parent ([a-f0-9]+)$/.exec(header);
          if (!parent?.[1] || parent[1].length !== object.id.length) incompletePublicationScan();
          children.push({ id: decode(hashSchema, parent[1], "publication commit parent") });
        }
      }
      assertPublicationText(content);
      if (object.format === "yaml") assertPublicationYaml(content);
    }
    offset += object.size + 1;
  }
  if (offset !== bytes.length) incompletePublicationScan();
  return children;
}
