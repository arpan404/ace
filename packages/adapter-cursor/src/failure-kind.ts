// Cursor reports exhausted usage only in prose, with no error code: "Increase limits for faster
// responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to
// continue." Read it leniently, but only to word the failure; anything else keeps its SDK
// classification.
const outOfUsage = /\bout of usage\b|\busage limit\b|\bhit your [\w-]+ limit\b/i;
const suggestsModel = /\bswitch to auto\b|\b(?:another|a different) model\b/i;

/**
 * How a failed Cursor run is classified. Only the SDK's own `rate_limit` code is a usage limit
 * (a quota state that holds queued messages). Out-of-usage prose stays a failed turn that holds
 * nothing, named so it reads as a limit; when Cursor says another model would still run, the
 * code asks for a model change.
 */
export function cursorFailure(
  code: unknown,
  message: string,
): { kind: "auth" | "quota" | "network" | "provider"; code?: string } {
  if (code === "auth") return { kind: "auth" };
  if (code === "rate_limit") return { kind: "quota" };
  if (code === "network") return { kind: "network" };
  if (outOfUsage.test(message))
    return { kind: "provider", code: suggestsModel.test(message) ? "model_quota" : "usage_limit" };
  return { kind: "provider" };
}
