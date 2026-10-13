import {
  ProviderLoginRequest,
  ProviderAccountsRequest,
  type DeviceId,
  type ProviderLoginResult,
} from "@ace/protocol";
import type { HostChannel } from "@ace/relay";
import type { ProviderLoginSessions } from "@ace/accounts";
import type { AccountManagement } from "../account-management.ts";
import { providerAccounts } from "../provider-accounts.ts";
import { logError, logFields } from "@ace/diagnostics";
import { unavailableLogin, type LoginWarn } from "./login-refusal.ts";

/**
 * The relay authenticates the device before constructing this endpoint; all frames are encrypted.
 * Services are read when a request arrives: the relay connects during startup, before the login
 * and account services finish starting, and a channel may outlive a service restart.
 */
export function providerAuthRelay(options: {
  channel: HostChannel;
  device: DeviceId;
  authorize(scope: "read" | "operate"): boolean;
  login(): ProviderLoginSessions | undefined;
  accounts(): AccountManagement | undefined;
  warn?: LoginWarn;
}) {
  const { channel, device, authorize, warn } = options;
  let closed = false;
  let listening: ProviderLoginSessions | undefined;
  let stop: (() => void) | undefined;
  // Progress pushes follow the login service this channel last saw.
  const login = () => {
    const service = options.login();
    if (service && service !== listening && !closed) {
      stop?.();
      listening = service;
      stop = service.listen((owner, progress) => {
        if (!closed && owner === device && authorize("operate"))
          void channel
            .send({ type: "provider.login.progress", progress })
            .catch(() => channel.close());
      });
    }
    return service;
  };
  login();
  return {
    async accept(message: import("@ace/protocol").ClientMessage) {
      if (closed || channel.bufferedBytes > 262144) {
        channel.close();
        return;
      }
      const account = ProviderAccountsRequest.safeParse(message);
      if (account.success) {
        const request = account.data;
        const scope = request.type === "provider.accounts.list" ? "read" : "operate";
        const accounts = options.accounts();
        const sessions = login();
        if (!authorize(scope) || !accounts || !sessions) {
          await channel.send({
            type: "provider.accounts.result",
            requestId: request.requestId,
            result: { ok: false, error: !authorize(scope) ? "forbidden" : "unavailable" },
          });
          return;
        }
        try {
          const result = await providerAccounts(accounts, sessions, device, request);
          if (!closed && authorize(scope)) await channel.send(result);
        } catch (cause) {
          warn?.(
            "Provider account request failed",
            logFields([
              ["request", request.type],
              ["provider", request.provider],
              ["transport", "relay"],
              ["error", logError(cause)],
            ]),
          );
          if (!closed && authorize(scope))
            await channel.send({
              type: "provider.accounts.result",
              requestId: request.requestId,
              result: { ok: false, error: "failed" },
            });
        }
        return;
      }
      const parsed = ProviderLoginRequest.safeParse(message);
      if (!parsed.success) throw new Error("Unexpected provider-auth request");
      const request = parsed.data;
      const refusal = { warn, transport: "relay" as const };
      try {
        if (!authorize("operate")) {
          await channel.send({
            type: "provider.login.result",
            requestId: request.requestId,
            result: { ok: false, error: "forbidden" },
          });
          return;
        }
        const service = login();
        let result: ProviderLoginResult;
        try {
          result = service
            ? await service.handle(device, request)
            : unavailableLogin(request, "not_running", refusal);
        } catch (cause) {
          result = unavailableLogin(request, "error", { ...refusal, cause });
        }
        if (!closed && authorize("operate")) await channel.send(result);
      } finally {
        if (request.type === "provider.login.apiKey") request.apiKey = "";
        if (message.type === "provider.login.apiKey") message.apiKey = "";
      }
    },
    binary() {
      throw new Error("Provider auth has no binary input");
    },
    close() {
      closed = true;
      stop?.();
    },
  };
}
