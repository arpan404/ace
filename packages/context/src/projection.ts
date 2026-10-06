import { canonicalBase64 } from "./base64.ts";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { type ContextDiagnostic as Diagnostic } from "@ace/protocol";
import { requireContext } from "./errors.ts";
import { languageHint } from "./file-kind.ts";

export const PreparedAttachment = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().max(1024),
  mimeType: z.string().max(128),
  bytes: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  nativeImage: z.boolean().optional(),
  text: z
    .string()
    .max(4 * 1024 * 1024)
    .optional(),
  base64: z
    .string()
    .max(44 * 1024 * 1024)
    .refine(canonicalBase64, "Invalid canonical base64")
    .optional(),
});
export type PreparedAttachment = z.infer<typeof PreparedAttachment>;
export const ProjectionCapabilities = z.object({
  provider: z.enum(["claude", "codex", "opencode", "acp"]),
  images: z.array(z.string().max(128)).max(32),
  documents: z.array(z.string().max(128)).max(32),
  embeddedContext: z.boolean(),
  maxInlineBytes: z
    .number()
    .int()
    .nonnegative()
    .max(32 * 1024 * 1024),
});
export type ProjectionCapabilities = z.infer<typeof ProjectionCapabilities>;
type Text = { type: "text"; text: string };
type Source = { type: "base64"; media_type: string; data: string };
export type ClaudeInput =
  | Text
  | { type: "image"; source: Source }
  | {
      type: "document";
      source: Source | { type: "text"; media_type: "text/plain"; data: string };
      title: string;
      path: string;
    };
export type CodexInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string; mimeType?: string };
export type OpenCodeInput = Text | { type: "file"; mime: string; filename: string; url: string };
export type AcpInput =
  | Text
  | { type: "image"; mimeType: string; data: string }
  | {
      type: "resource";
      resource:
        | { uri: string; mimeType: string; text: string }
        | { uri: string; mimeType: string; blob: string };
    };
export type Projection =
  | { provider: "claude"; input: ClaudeInput[]; diagnostics: Diagnostic[] }
  | { provider: "codex"; input: CodexInput[]; diagnostics: Diagnostic[] }
  | { provider: "opencode"; input: OpenCodeInput[]; diagnostics: Diagnostic[] }
  | { provider: "acp"; input: AcpInput[]; diagnostics: Diagnostic[] };
// URL construction stays pure and works on Windows drive letters and POSIX paths.
export function fileUri(path: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  requireContext(
    windows || path.startsWith("/"),
    "invalid_request",
    "Provider file paths must be absolute",
  );
  return pathToFileURL(path, { windows }).href;
}
export function projectAttachments(
  values: readonly PreparedAttachment[],
  settings: ProjectionCapabilities,
): Projection {
  const capabilities = ProjectionCapabilities.parse(settings);
  requireContext(values.length <= 256, "quota", "Too many projected attachments");
  const attachments = values.map((value) => PreparedAttachment.parse(value));
  let inlineBytes = 0;
  for (const attachment of attachments) {
    inlineBytes += attachment.text === undefined ? 0 : Buffer.byteLength(attachment.text);
    inlineBytes +=
      attachment.base64 === undefined
        ? 0
        : (attachment.base64.length / 4) * 3 -
          (attachment.base64.endsWith("==") ? 2 : attachment.base64.endsWith("=") ? 1 : 0);
  }
  requireContext(inlineBytes <= 36 * 1024 * 1024, "quota", "Prepared context exceeds memory bound");
  const diagnostics: Diagnostic[] = [];
  let remaining = capabilities.maxInlineBytes;
  function data(attachment: PreparedAttachment): string | undefined {
    if (attachment.base64 === undefined) return undefined;
    const size =
      (attachment.base64.length / 4) * 3 -
      (attachment.base64.endsWith("==") ? 2 : attachment.base64.endsWith("=") ? 1 : 0);
    if (size > remaining) return undefined;
    remaining -= size;
    return attachment.base64;
  }
  function fallback(attachment: PreparedAttachment): Text {
    return {
      type: "text",
      text: `Attachment ${JSON.stringify(attachment.name)} (${attachment.mimeType}, ${attachment.bytes ?? "unknown"} bytes) sent as file. Read the full file at ${JSON.stringify(attachment.path)}.`,
    };
  }
  function text(attachment: PreparedAttachment): string {
    if (attachment.bytes === undefined) return attachment.text ?? "";
    return `Attachment ${JSON.stringify(attachment.name)} (${attachment.mimeType}, ${attachment.bytes} bytes; language: ${languageHint(attachment.name)}).\n<ace-attachment>\n${attachment.text ?? ""}\n</ace-attachment>${attachment.truncated ? `\n[Inline text truncated.] ${fallback(attachment).text}` : ""}`;
  }
  switch (capabilities.provider) {
    case "claude": {
      const input: ClaudeInput[] = attachments.map((a) => {
        if (a.text !== undefined) return { type: "text", text: text(a) };
        const image =
          a.nativeImage !== false &&
          a.mimeType.startsWith("image/") &&
          capabilities.images.includes(a.mimeType);
        const document =
          (a.mimeType === "application/pdf" || a.mimeType === "text/plain") &&
          capabilities.documents.includes(a.mimeType);
        const encoded = image || document ? data(a) : undefined;
        if (encoded === undefined) return fallback(a);
        const source: Source = { type: "base64", media_type: a.mimeType, data: encoded };
        if (image) return { type: "image", source };
        if (a.mimeType === "text/plain") {
          try {
            const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.from(encoded, "base64"),
            );
            return {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: decoded },
              title: a.name,
              path: a.path,
            };
          } catch {
            return fallback(a);
          }
        }
        return { type: "document", source, title: a.name, path: a.path };
      });
      return { provider: "claude", input, diagnostics };
    }
    case "codex": {
      const input: CodexInput[] = attachments.map((a) => {
        if (a.text !== undefined) return { type: "text", text: text(a), text_elements: [] };
        if (
          a.nativeImage !== false &&
          capabilities.images.includes(a.mimeType) &&
          (a.bytes === undefined || a.bytes <= remaining)
        ) {
          remaining -= a.bytes ?? 0;
          return { type: "localImage", path: a.path, mimeType: a.mimeType };
        }
        return { ...fallback(a), text_elements: [] };
      });
      return { provider: "codex", input, diagnostics };
    }
    case "opencode": {
      const input: OpenCodeInput[] = attachments.map((a) => {
        if (a.text !== undefined) return { type: "text", text: text(a) };
        if (a.nativeImage !== false && capabilities.images.includes(a.mimeType)) {
          const encoded = data(a);
          if (encoded === undefined) return fallback(a);
          return {
            type: "file",
            mime: a.mimeType,
            filename: a.name,
            url: `data:${a.mimeType};base64,${encoded}`,
          };
        }
        if (capabilities.documents.includes(a.mimeType))
          return { type: "file", mime: a.mimeType, filename: a.name, url: fileUri(a.path) };
        return fallback(a);
      });
      return { provider: "opencode", input, diagnostics };
    }
    case "acp": {
      const input: AcpInput[] = attachments.map((a) => {
        if (a.text !== undefined)
          return capabilities.embeddedContext
            ? {
                type: "resource",
                resource: {
                  uri: a.path.startsWith("ace://") ? a.path : fileUri(a.path),
                  mimeType: a.mimeType,
                  text: text(a),
                },
              }
            : { type: "text", text: text(a) };
        const image = a.nativeImage !== false && capabilities.images.includes(a.mimeType);
        const document =
          capabilities.embeddedContext &&
          (capabilities.documents.includes(a.mimeType) || capabilities.documents.includes("*"));
        const encoded = image || document ? data(a) : undefined;
        if (encoded === undefined) return fallback(a);
        return image
          ? { type: "image", mimeType: a.mimeType, data: encoded }
          : {
              type: "resource",
              resource: { uri: fileUri(a.path), mimeType: a.mimeType, blob: encoded },
            };
      });
      return { provider: "acp", input, diagnostics };
    }
  }
}
