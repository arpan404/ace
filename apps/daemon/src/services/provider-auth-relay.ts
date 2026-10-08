import { ProviderLoginRequest, ProviderAccountsRequest, type DeviceId } from "@ace/protocol";
import type { HostChannel } from "@ace/relay";
import type { ProviderLoginSessions } from "@ace/accounts";
import type { AccountManagement } from "../account-management.ts";
import { providerAccounts } from "../provider-accounts.ts";

/** The relay authenticates the device before constructing this endpoint; all frames are encrypted. */
export function providerAuthRelay(options: {
  channel: HostChannel;
  device: DeviceId;
  authorize(scope: "read" | "operate"): boolean;
  login?: ProviderLoginSessions;
  accounts?: AccountManagement;
}) {
  const { channel, device, authorize, login, accounts } = options;
  let closed = false;
  const stop = login?.listen((owner, progress) => {
    if (!closed && owner === device && authorize("operate"))
      void channel.send({ type: "provider.login.progress", progress }).catch(() => channel.close());
  });
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
        if (!authorize(scope) || !accounts || !login) {
          await channel.send({
            type: "provider.accounts.result",
            requestId: request.requestId,
            result: { ok: false, error: !authorize(scope) ? "forbidden" : "unavailable" },
          });
          return;
        }
        try {
          const result = await providerAccounts(accounts, login, device, request);
          if (!closed && authorize(scope)) await channel.send(result);
        } catch {
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
      try {
        if (!authorize("operate") || !login) {
          await channel.send({
            type: "provider.login.result",
            requestId: request.requestId,
            result: { ok: false, error: !authorize("operate") ? "forbidden" : "unavailable" },
          });
          return;
        }
        const result = await login.handle(device, request);
        if (!closed && authorize("operate")) await channel.send(result);
      } catch {
        if (!closed && authorize("operate"))
          await channel.send({
            type: "provider.login.result",
            requestId: request.requestId,
            result: { ok: false, error: "unavailable" },
          });
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
