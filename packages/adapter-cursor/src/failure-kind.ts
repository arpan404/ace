// Cursor reports exhausted usage only in prose, with no error code: "Increase limits for faster
// responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to
// continue." Read it leniently; anything else keeps its SDK classification.
const outOfUsage = /\bout of usage\b|\busage limit\b|\bhit your [\w-]+ limit\b/i;
const suggestsModel = /\bswitch to auto\b|\b(?:another|a different) model\b/i;

/**
 * How a failed Cursor run is classified. A usage limit is a quota state rather than a provider
 * failure; when Cursor says another model would still run, the code asks for a model change.
 */
export function cursorFailure(
  code: unknown,
  message: string,
): { kind: "auth" | "quota" | "network" | "provider"; code?: string } {
  if (code === "auth") return { kind: "auth" };
  if (code === "rate_limit") return { kind: "quota" };
  if (code === "network") return { kind: "network" };
  if (outOfUsage.test(message))
    return suggestsModel.test(message) ? { kind: "quota", code: "model_quota" } : { kind: "quota" };
  return { kind: "provider" };
}
