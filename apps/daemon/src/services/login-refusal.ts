import { logError, logFields } from "@ace/diagnostics";
import type {
  ProviderLoginRequest,
  ProviderLoginResult,
  ProviderLoginUnavailableReason,
} from "@ace/protocol";

export type LoginWarn = (message: string, fields: object) => void;

/**
 * Sign-in answered `unavailable`, with the reason the client shows. The cause goes to the
 * daemon's redacting log at warn level first, so a refused sign-in is never silent. The request
 * itself is never logged: an API key request carries a secret.
 */
export function unavailableLogin(
  request: ProviderLoginRequest,
  reason: ProviderLoginUnavailableReason,
  context: { warn: LoginWarn | undefined; transport: "socket" | "relay"; cause?: unknown },
): ProviderLoginResult {
  try {
    context.warn?.(
      "Provider sign-in unavailable",
      logFields([
        ["request", request.type],
        ...("provider" in request ? [["provider", request.provider] as const] : []),
        ["reason", reason],
        ["transport", context.transport],
        ...("cause" in context ? [["error", logError(context.cause)] as const] : []),
      ]),
    );
  } catch {
    // The refusal still reaches the client when the log sink is failing.
  }
  return {
    type: "provider.login.result",
    requestId: request.requestId,
    result: { ok: false, error: "unavailable", reason },
  };
}
