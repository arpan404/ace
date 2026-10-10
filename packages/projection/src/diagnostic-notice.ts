import type { Item } from "@ace/protocol";

const copy: Readonly<Record<string, string>> = {
  "cursor.work-stopped":
    "Cursor stopped; some work may not have finished. Send a message to continue.",
  "cursor.run-failed": "Cursor couldn't finish the request. Try again.",
};

/** Adapter evidence never supplies its own user-facing wording. */
export function diagnosticNoticeText(item: Extract<Item, { type: "notice" }>): string | undefined {
  return item.code ? copy[item.code] : undefined;
}
export function isDiagnosticNotice(item: Extract<Item, { type: "notice" }>): boolean {
  return item.diagnostic === true || item.raw.some((raw) => raw.type === "cursor.sdk.v1");
}
