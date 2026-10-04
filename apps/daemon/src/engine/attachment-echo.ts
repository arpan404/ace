import { createHash } from "node:crypto";
import type { Fact } from "@ace/core";
import type { Attachment, ContentPart } from "@ace/protocol";

function contentHash(part: ContentPart): string | undefined {
  if (part.type === "text") return undefined;
  if (part.type === "file") return /(?:^|[\\/])([a-f0-9]{64})(?:\.[a-z]+)?$/.exec(part.path)?.[1];
  const data = /^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/.exec(part.url);
  if (data?.[1] && data[1].length <= 6 * 1024 * 1024)
    return createHash("sha256").update(Buffer.from(data[1], "base64")).digest("hex");
  return undefined;
}
/** Only verified, thread-owned uploads replace provider-local paths and inline image echoes. */
export function attachmentEcho(fact: Fact, known: ReadonlyMap<string, Attachment>): Fact {
  if (
    (fact.type !== "item.upsert" && fact.type !== "item.reconciled") ||
    fact.draft.type !== "message" ||
    fact.draft.role !== "user"
  )
    return fact;
  const attachments: Attachment[] = [],
    parts: ContentPart[] = [];
  for (const part of fact.draft.parts ?? []) {
    const hash = contentHash(part),
      attachment = hash ? known.get(hash) : undefined;
    if (attachment) {
      if (!attachments.some((a) => a.sha256 === attachment.sha256)) attachments.push(attachment);
    } else parts.push(part);
  }
  if (!attachments.length) return fact;
  // Native payloads contain the same host path/base64. Keep those in provider diagnostics only.
  return { ...fact, draft: { ...fact.draft, parts, attachments, raw: [] } };
}
