import type { Item } from "@ace/protocol";

/** Older records keep native diagnostics as raw evidence, never as conversation. */
export function displayNotice(item: Extract<Item, { type: "notice" }>) {
  if (item.raw.some((raw) => raw.type === "native-notice" || raw.type === "stderr"))
    return undefined;
  if (
    item.raw.some((raw) => raw.type === "cursor.sdk.v1") &&
    /^(?:Malformed SDK boundary|Checkpoint snapshot retained|Shell output has no observed|SDK (?:task summary|checkpoint recovery))/.test(
      item.text,
    )
  )
    return undefined;
  return {
    ...item,
    text: noticeText(item.text),
    ...(item.title ? { title: noticeText(item.title) } : {}),
    ...(item.detail ? { detail: noticeText(item.detail) } : {}),
  };
}

export function noticeText(text: string): string {
  const cleaned = text
    // CSI styles and OSC terminal hyperlinks from old CLI stderr.
    // oxlint-disable-next-line eslint/no-control-regex -- Strip stored terminal escape sequences.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    // oxlint-disable-next-line eslint/no-control-regex -- Strip stored terminal escape sequences.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim()
    .replace(/^(?:[a-z][\w-]*\.[\w.-]+:\s*)+/i, "");
  if (/\bmodel_unavailable\b/.test(cleaned))
    return "The selected model isn't available. Pick another model.";
  if (/No adapter registered for /i.test(cleaned))
    return "The provider isn't ready. Check its connection in Settings and try again.";
  if (cleaned.startsWith("SDK host exited;"))
    return "Cursor stopped unexpectedly. Unfinished work needs your attention.";
  return cleaned;
}
