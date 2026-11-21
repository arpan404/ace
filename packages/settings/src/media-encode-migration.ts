/**
 * `media.encode` lost its `legacy` value (docs/media/plan.md, X2): a stored `legacy` is removed
 * on the next read, so it reads as the default, `auto`, and the rest of the document still loads.
 */
export function retiredMediaEncode(data: unknown): boolean {
  if (typeof data !== "object" || data === null || !("settings" in data)) return false;
  const settings = data.settings;
  return (
    typeof settings === "object" &&
    settings !== null &&
    "media.encode" in settings &&
    settings["media.encode"] === "legacy"
  );
}
