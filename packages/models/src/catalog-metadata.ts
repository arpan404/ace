import { z } from "zod";

const id = z.string().min(1).max(256);
// Decode optional hints independently: one malformed extension must not erase others.
const metadata = z.object({
  status: z.string().optional().catch(undefined),
  resolvedModel: id.optional().catch(undefined),
  resolvedModelId: id.optional().catch(undefined),
  aliases: z.array(id).max(32).optional().catch(undefined),
  deprecated: z.boolean().optional().catch(undefined),
  legacy: z.boolean().optional().catch(undefined),
  internal: z.boolean().optional().catch(undefined),
  type: z.string().optional().catch(undefined),
  task: z.string().optional().catch(undefined),
  capabilities: z
    .object({ chat: z.boolean().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

export function catalogMetadata(value: unknown): z.infer<typeof metadata> {
  const parsed = metadata.safeParse(value);
  return parsed.success ? parsed.data : {};
}
export function chatMetadata(value: unknown): boolean {
  const info = catalogMetadata(value);
  return (
    !info.internal &&
    info.status?.toLowerCase() !== "internal" &&
    info.capabilities?.chat !== false &&
    ![info.type, info.task].some(
      (hint) =>
        hint && /^(?:embedding|rerank|transcription|image-generation|speech|internal)$/i.test(hint),
    )
  );
}
export function legacyMetadata(value: unknown): boolean {
  const info = catalogMetadata(value);
  return Boolean(
    info.legacy || info.deprecated || /^(?:legacy|deprecated|retired)$/i.test(info.status ?? ""),
  );
}
