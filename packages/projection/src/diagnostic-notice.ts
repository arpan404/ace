import type { Item } from "@ace/protocol";

const copy: Readonly<Record<string, string>> = {
  "cursor.work-stopped":
    "Cursor stopped; some work may not have finished. Send a message to continue.",
  "cursor.run-failed": "Cursor couldn't finish the request. Try again.",
};

type Notice = Extract<Item, { type: "notice" }>;

/** The diagnostic's code; older Cursor SDK records name a host exit only in their text. */
function diagnosticCode(item: Notice): string | undefined {
  return (
    item.code ??
    (item.raw.some((raw) => raw.type === "cursor.sdk.v1") &&
    item.text.startsWith("SDK host exited;")
      ? "cursor.work-stopped"
      : undefined)
  );
}

/** Adapter evidence never supplies its own user-facing wording. */
export function diagnosticNoticeText(item: Notice): string | undefined {
  const code = diagnosticCode(item);
  return code ? copy[code] : undefined;
}

/** An adapter's report that the provider's process stopped with work unfinished. */
export function isWorkStoppedNotice(item: Item | undefined): boolean {
  return (
    item?.type === "notice" &&
    isDiagnosticNotice(item) &&
    diagnosticCode(item) === "cursor.work-stopped"
  );
}
export function isDiagnosticNotice(item: Extract<Item, { type: "notice" }>): boolean {
  return item.diagnostic === true || item.raw.some((raw) => raw.type === "cursor.sdk.v1");
}
