import { ToolEnvRequest, type ToolEnvResult } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";

/** Scrub credential values from a parsed or raw transport copy. */
function blank(candidate: unknown): void {
  if (typeof candidate !== "object" || candidate === null) return;
  const entries =
    "entries" in candidate && Array.isArray(candidate.entries) ? candidate.entries : undefined;
  if (!entries) return;
  for (const entry of entries)
    if (typeof entry === "object" && entry !== null && "value" in entry) entry.value = "";
}

/**
 * Thread-scoped tool credential hand-off. Mirrors the `provider.login.apiKey`
 * secrecy contract: operate scope plus a secret-submission gate, values held
 * only in daemon memory, transport buffers blanked after handling.
 */
export function createProviderToolEnvSession(context: SocketContext): SocketService {
  let pending = 0;
  return {
    async handle(message) {
      const request = ToolEnvRequest.safeParse(message);
      if (!request.success) return false;
      const input = request.data;
      const vault = context.options.toolEnvVault;
      const thread = context.options.store?.getThread(input.threadId);
      const live = !!thread && thread.deletedAt === undefined;
      const forbidden = !context.authorize("operate") || !context.canSubmitSecret?.();
      let result: ToolEnvResult["result"];
      if (forbidden) result = { ok: false, error: "forbidden" };
      else if (pending >= 8) result = { ok: false, error: "busy" };
      else if (!vault) result = { ok: false, error: "unavailable" };
      else if (!live) result = { ok: false, error: "not_found" };
      else {
        pending++;
        try {
          if (input.type === "provider.toolEnv.clear") {
            vault.release(input.threadId);
            result = { ok: true, stored: 0 };
          } else {
            const stored = vault.submit(
              input.threadId,
              Object.fromEntries(input.entries.map((entry) => [entry.key, entry.value])),
            );
            result = { ok: true, stored };
          }
        } catch {
          result = { ok: false, error: "invalid_input" };
        } finally {
          blank(input);
          blank(message);
          pending--;
        }
      }
      if (input.type === "provider.toolEnv.submit") {
        blank(input);
        blank(message);
      }
      // Refusals carry no secrets, so they go out whenever the socket is live.
      if (context.connected())
        context.send({ type: "provider.toolEnv.result", requestId: input.requestId, result });
      return true;
    },
  };
}
