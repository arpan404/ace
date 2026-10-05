import { createHash } from "node:crypto";
import type { Fact } from "@ace/core";
import type { Attachment, ContentPart } from "@ace/protocol";
import { attachmentPayload } from "./attachment-payload.ts";

function pathHash(value: string): string | undefined {
  return /(?:^|[\\/])([a-f0-9]{64})(?:\.[a-z]+)?$/.exec(value)?.[1];
}
function imageHash(value: string): string | undefined {
  const data = value.startsWith("data:")
    ? /^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/.exec(value)?.[1]
    : value;
  if (!data || data.length > 6 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    return undefined;
  return createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
}
function contentHash(part: ContentPart): string | undefined {
  if (part.type === "file") return pathHash(part.path);
  if (part.type === "image") return imageHash(part.url);
  return undefined;
}
/** Only verified, thread-owned uploads replace provider paths and inline image echoes.
 * Native envelopes remain available, with just matched payload fields replaced by content ids.
 */
export function attachmentEcho(fact: Fact, lookup: (hash: string) => Attachment | undefined): Fact {
  if (
    (fact.type !== "item.upsert" && fact.type !== "item.reconciled") ||
    fact.draft.type !== "message" ||
    fact.draft.role !== "user"
  )
    return fact;
  const attachments = new Map<string, Attachment>();
  const verified = new Map<string, Attachment | undefined>();
  const find = (hash: string | undefined) => {
    if (!hash) return undefined;
    if (!verified.has(hash)) verified.set(hash, lookup(hash));
    const attachment = verified.get(hash);
    if (attachment) attachments.set(hash, attachment);
    return attachment;
  };
  const parts = (fact.draft.parts ?? []).filter((part) => !find(contentHash(part)));
  const sanitize = (key: string, value: string): string => {
    const hash =
      key === "path"
        ? pathHash(value)
        : key === "url" || key === "uri"
          ? (pathHash(value) ?? imageHash(value))
          : key === "data"
            ? imageHash(value)
            : undefined;
    const attachment = find(hash);
    return attachment ? `attachment:${attachment.sha256}` : value;
  };
  const raw = fact.draft.raw?.map((entry) =>
    "data" in entry ? { ...entry, data: attachmentPayload(entry.data, sanitize) } : entry,
  );
  if (!attachments.size) return fact;
  return {
    ...fact,
    draft: {
      ...fact.draft,
      parts,
      attachments: [...attachments.values()],
      ...(raw ? { raw } : {}),
    },
  };
}
