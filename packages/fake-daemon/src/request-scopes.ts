import type { ClientMessage, DeviceScope, ServerMessage } from "@ace/protocol";

/* Which requests a paired device's scopes refuse, as the daemon's admission answers them. */

type DeviceScopes = Readonly<Record<string, readonly DeviceScope[]>> | undefined;

const accountChanges = new Set([
  "accounts.add",
  "accounts.rename",
  "accounts.remove",
  "accounts.setDefault",
  "accounts.login",
  "accounts.logout",
]);

/**
 * The refusal `deviceId` gets for `message` when its scopes don't cover it: a reply to send,
 * `"silent"` when refused with nothing to answer, or undefined when the request may go on.
 * Without configured scopes every device may do everything.
 */
export function scopeRefusal(
  message: ClientMessage,
  deviceScopes: DeviceScopes,
  deviceId: string,
): ServerMessage | "silent" | undefined {
  if (!deviceScopes) return undefined;
  const scopes = deviceScopes[deviceId];
  const requestId = "requestId" in message ? message.requestId : undefined;
  if (accountChanges.has(message.type)) {
    if (scopes?.some((scope) => scope === "accounts" || scope === "desktop")) return undefined;
    return {
      type: "error",
      code: "forbidden",
      message: "accounts scope required",
      ...(requestId ? { requestId } : {}),
    };
  }
  if (message.type === "admission.request" && message.operation !== "status") {
    if (scopes?.includes("operate")) return undefined;
    return {
      type: "admission.result",
      requestId: message.requestId,
      ok: false,
      error: "forbidden",
    };
  }
  if (message.type.startsWith("provider.install.")) {
    if (scopes?.includes("operate")) return undefined;
    return requestId
      ? { type: "provider.install.result", requestId, result: { ok: false, error: "forbidden" } }
      : "silent";
  }
  if (
    message.type.startsWith("provider.accounts.") ||
    message.type.startsWith("provider.login.") ||
    message.type === "provider.logout" ||
    message.type.startsWith("onboarding.")
  ) {
    const needed =
      message.type === "onboarding.query" || message.type === "provider.accounts.list"
        ? "read"
        : "operate";
    if (scopes?.includes(needed)) return undefined;
    if (!requestId) return "silent";
    const result = { ok: false as const, error: "forbidden" as const };
    if (message.type.startsWith("provider.accounts."))
      return { type: "provider.accounts.result", requestId, result };
    if (message.type.startsWith("onboarding."))
      return { type: "onboarding.result", requestId, result };
    return { type: "provider.login.result", requestId, result };
  }
  return undefined;
}
