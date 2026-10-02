import { Mention, type ContextDiagnostic, type ResolvedMention } from "@ace/protocol";
import { ContextError, requireContext } from "./errors.ts";
import type { WorkspaceFiles } from "./git-workspace.ts";

export interface MentionLimits {
  fileBytes: number;
  totalBytes: number;
  files: number;
}
export const defaultMentionLimits: MentionLimits = {
  fileBytes: 64 * 1024,
  totalBytes: 256 * 1024,
  files: 128,
};
export async function resolveMentions(
  workspace: WorkspaceFiles,
  mentions: readonly Mention[],
  limits = defaultMentionLimits,
): Promise<{ entries: ResolvedMention[]; diagnostics: ContextDiagnostic[] }> {
  requireContext(
    Number.isInteger(limits.fileBytes) &&
      Number.isInteger(limits.totalBytes) &&
      Number.isInteger(limits.files) &&
      limits.files <= 128 &&
      limits.fileBytes > 0 &&
      limits.totalBytes > 0 &&
      limits.files > 0 &&
      limits.fileBytes <= 1024 * 1024 &&
      limits.totalBytes <= 4 * 1024 * 1024,
    "invalid_request",
    "Invalid mention limits",
  );
  requireContext(mentions.length <= 64, "quota", "Too many mentions");
  const entries: ResolvedMention[] = [];
  const diagnostics: ContextDiagnostic[] = [];
  let remaining = limits.totalBytes;
  let count = 0;
  const visit = async (path: string, lines?: Mention["lines"]) => {
    if (count >= limits.files || remaining <= 0) return false;
    count++;
    try {
      const { bytes, more } = await workspace.read(path, limits.fileBytes);
      const decoded = new TextDecoder("utf-8", { fatal: true });
      let text: string;
      try {
        if (bytes.includes(0)) throw new Error("Binary");
        // A partial UTF-8 codepoint at the cap is not a binary file.
        text = decoded.decode(bytes, { stream: more });
      } catch {
        throw new ContextError("binary", "Binary file omitted; use its path or upload it");
      }
      let selectedTruncated = more;
      if (lines) {
        const selected = text.split("\n");
        requireContext(
          lines.start <= selected.length && (!more || lines.start < selected.length),
          "invalid_request",
          "Line range starts beyond available context",
        );
        selectedTruncated = more && lines.end >= selected.length;
        text = selected.slice(lines.start - 1, lines.end).join("\n");
      }
      const marker = "\n[ace: context truncated]\n";
      const label = `File: ${path}${lines ? `:${lines.start}-${lines.end}` : ""}\n`;
      const source = label + text;
      const needsTruncation = selectedTruncated || Buffer.byteLength(source) > remaining;
      let output = source;
      if (needsTruncation) {
        requireContext(
          remaining >= Buffer.byteLength(marker),
          "truncated",
          "Total context limit reached",
        );
        const body = Buffer.from(source).subarray(0, remaining - Buffer.byteLength(marker));
        output = new TextDecoder().decode(body).replace(/\uFFFD$/, "") + marker;
        diagnostics.push({
          code: "truncated",
          path,
          message: "File or total context limit reached",
        });
      }
      remaining -= Buffer.byteLength(output);
      entries.push({ path, text: output, truncated: needsTruncation });
    } catch (error) {
      diagnostics.push({
        code: error instanceof ContextError ? error.code : "not_found",
        path,
        message: error instanceof ContextError ? error.message : "File unavailable",
      });
    }
    return true;
  };
  for (const value of mentions) {
    const mention = Mention.parse(value);
    try {
      const kind = await workspace.inspect(mention.path);
      if (kind === "file") {
        if (!(await visit(mention.path, mention.lines)))
          diagnostics.push({
            code: "truncated",
            path: mention.path,
            message: "Context limit reached",
          });
      } else {
        requireContext(!mention.lines, "invalid_request", "Folders do not have line ranges");
        for (const path of workspace.index.under(mention.path.replace(/\/$/, ""))) {
          if (!(await visit(path))) {
            diagnostics.push({
              code: "truncated",
              path: mention.path,
              message: "Folder expansion limit reached",
            });
            break;
          }
        }
      }
    } catch (error) {
      diagnostics.push({
        code: error instanceof ContextError ? error.code : "not_found",
        path: mention.path,
        message: error instanceof ContextError ? error.message : "Mention unavailable",
      });
    }
  }
  return { entries, diagnostics };
}
