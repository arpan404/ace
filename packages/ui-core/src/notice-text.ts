import type { Item } from "@ace/protocol";
import { diagnosticNoticeText, isDiagnosticNotice } from "@ace/projection";

/** Older records keep native diagnostics as raw evidence, never as conversation. */
export function displayNotice(item: Extract<Item, { type: "notice" }>) {
  if (item.raw.some((raw) => raw.type === "native-notice" || raw.type === "stderr"))
    return undefined;
  if (isDiagnosticNotice(item)) {
    const text = diagnosticNoticeText(item);
    return text
      ? { ...item, text, title: undefined, detail: undefined, details: undefined }
      : undefined;
  }
  return {
    ...item,
    text: noticeText(item.text),
    ...(item.title ? { title: noticeText(item.title) } : {}),
    ...(item.detail ? { detail: noticeText(item.detail) } : {}),
  };
}

export function noticeText(text: string): string {
  const cleaned = stripAnsi(text)
    .trim()
    .replace(/^(?:[a-z][\w-]*\.[\w.-]+:\s*)+/i, "");
  if (/\bmodel_unavailable\b/.test(cleaned))
    return "The selected model isn't available. Pick another model.";
  if (/No adapter registered for /i.test(cleaned))
    return "The provider isn't ready. Check its connection in Settings and try again.";
  return cleaned;
}

export function stripAnsi(text: string): string {
  return (
    text
      // CSI styles and OSC terminal hyperlinks from old CLI stderr.
      // oxlint-disable-next-line eslint/no-control-regex -- Strip stored terminal escape sequences.
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
      // oxlint-disable-next-line eslint/no-control-regex -- Strip stored terminal escape sequences.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  );
}
