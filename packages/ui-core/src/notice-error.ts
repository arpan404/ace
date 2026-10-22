import type { Item, ProviderKind } from "@ace/protocol";
import type { ErrorInput } from "./error-display.ts";

/** A notice's structured error fields (C-A `code`/`title`/`detail`, #116 `details`), if any. */
export function noticeError(item: Extract<Item, { type: "notice" }>): ErrorInput {
  const record = item as Record<string, unknown>;
  const text = (key: string) =>
    typeof record[key] === "string" ? (record[key] as string) : undefined;
  const details =
    typeof record["details"] === "object" && record["details"] !== null
      ? (record["details"] as Record<string, unknown>)
      : {};
  return {
    text: item.text,
    code: text("code") ?? (typeof details["code"] === "string" ? details["code"] : undefined),
    title: text("title"),
    detail: text("detail"),
    provider:
      typeof details["provider"] === "string" ? (details["provider"] as ProviderKind) : undefined,
    model: typeof details["model"] === "string" ? details["model"] : undefined,
  };
}
