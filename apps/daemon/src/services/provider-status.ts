import { createCursorAccountDriver, discoverCursorSdk } from "@ace/adapter-cursor";
import { ProviderStatuses } from "../provider-status.ts";
import { daemonCursorInstance } from "./cursor-instance.ts";
import { cursorHosts } from "./cursor-hosts.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function startProviderStatuses(context: ServiceContext): void {
  const cursor = context.options.engine?.cursor;
  const driver = createCursorAccountDriver({
    ...cursor,
    limits: { ...cursor?.limits, timeoutMs: 4000 },
    slots: cursorHosts(context),
    launchEnv: cursor?.env ?? process.env,
    stopInstance: async () => {
      throw new Error("Discovery cannot change authentication");
    },
  });
  const statuses = new ProviderStatuses(
    {
      ...context.options.providerStatus,
      cursorSdk:
        context.options.providerStatus?.cursorSdk ??
        (async (signal) => {
          const sdk = await discoverCursorSdk(cursor?.discovery);
          const installation = {
            installed: sdk.installed,
            ...(sdk.module ? { path: sdk.module } : {}),
            ...(sdk.version ? { version: sdk.version } : {}),
            auth: "unknown" as const,
            loginHint: "Cursor SDK sign-in is separate from agent login",
          };
          if (!sdk.installed) return installation;
          if (!sdk.supported)
            return { ...installation, error: "Cursor SDK version or runtime unsupported" };
          const selected = context.services.accountRegistry?.selectedCursorSdk();
          const account = selected ? context.services.accountRegistry?.get(selected) : undefined;
          const instance = account?.instance ?? daemonCursorInstance(context);
          try {
            if (context.services.cursorAccounts?.isFenced(instance.id))
              throw new Error("SDK auth change in progress");
            const status = await driver.status(instance, signal);
            return {
              ...installation,
              auth: status.status === "logged-in" ? "logged_in" : "logged_out",
              authDetail: status.source,
            };
          } catch {
            return { ...installation, error: "Cursor SDK authentication status unavailable" };
          }
        }),
    },
    {
      now: context.now,
      schedule(expire, ms) {
        const timer = setTimeout(expire, ms);
        timer.unref();
        return () => clearTimeout(timer);
      },
    },
  );
  context.services.providerStatuses = statuses;
  context.resources.own(() => statuses.close());
}
export function createProviderStatusesSession(context: SocketContext): SocketService {
  let pending = 0;
  return {
    async handle(message) {
      if (message.type !== "providers.request") return false;
      const reply = (result: import("@ace/protocol").ProvidersResult["result"]) =>
        context.send({ type: "providers.result", requestId: message.requestId, result });
      if (!context.authorize(message.operation === "refresh" ? "operate" : "read"))
        reply({ ok: false, error: "forbidden" });
      else if (!context.options.providerStatuses) reply({ ok: false, error: "unavailable" });
      else if (pending >= 8) reply({ ok: false, error: "busy" });
      else {
        pending++;
        try {
          if (message.operation === "refresh") await context.options.providerStatuses.refresh();
          if (context.connected() && context.authorize("read"))
            reply({ ok: true, providers: context.options.providerStatuses.list() });
        } finally {
          pending--;
        }
      }
      return true;
    },
  };
}
