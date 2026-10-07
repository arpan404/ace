import { loginUrl } from "@ace/accounts";
import type { ProviderLoginDriver } from "@ace/accounts";
import type { CursorAuthService } from "@ace/accounts";
import type { CursorAuthEvent } from "@ace/protocol";

/** Reuses the SDK host's credential containment and account fencing. */
export function cursorLoginDriver(
  auth: CursorAuthService,
  owner: string,
  instance: string,
  action: "login" | "logout",
  id: () => string,
): ProviderLoginDriver {
  let ownedLoginId: string | undefined;
  const drain = async () => {
    if (!ownedLoginId) return;
    const result = await auth.handle(owner, {
      type: "cursor.auth.cancel",
      requestId: id(),
      loginId: ownedLoginId,
    });
    if (result.type !== "cursor.auth.login" || ["starting", "browser"].includes(result.state))
      throw new Error("SDK cleanup unavailable");
    ownedLoginId = undefined;
  };
  return {
    drain,
    async run(signal, emit) {
      let event = await auth.handle(owner, {
        type: action === "login" ? "cursor.auth.start" : "cursor.auth.logout",
        requestId: id(),
        instanceId: instance,
      });
      if (action === "logout") return { success: event.type === "cursor.auth.changed" };
      ownedLoginId = event.type === "cursor.auth.login" ? event.loginId : undefined;
      const next = (observation: CursorAuthEvent) => {
        if (observation.type !== "cursor.auth.login") throw new Error("SDK auth unavailable");
        ownedLoginId = observation.loginId;
        return observation;
      };
      try {
        for (;;) {
          signal.throwIfAborted();
          const progress = next(event);
          if (progress.state === "complete")
            return { success: progress.auth?.status === "logged-in" };
          if (progress.state === "failed" || progress.state === "cancelled")
            return { success: false };
          const url = progress.url ? loginUrl("cursor", progress.url) : undefined;
          if (progress.url && !url) throw new Error("Unrecognized SDK challenge");
          emit({
            state: url ? "awaiting_browser" : "starting",
            ...(url ? { url } : {}),
            hint: "Cursor SDK sign-in is separate from Cursor CLI and editor sign-in.",
          });
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(new Error("Cancelled"));
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, 250);
            timer.unref();
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
          event = await auth.handle(owner, {
            type: "cursor.auth.poll",
            requestId: id(),
            loginId: progress.loginId,
          });
        }
      } finally {
        await drain();
      }
    },
  };
}
