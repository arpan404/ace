import { marketOrigin, shippedMarketKeys } from "@ace/marketplace";
import type { ServerOptions } from "../server-options.ts";
import { osKeychain, type RegistryKeychain } from "./keychain.ts";
import { registrySignerLoop } from "./loop.ts";
import { signRegistry } from "./signer.ts";

/**
 * The registry signer loop for a daemon with an ace sign-in (ADR 0206 §5.2): it runs on every
 * machine and signs only on an organization's host whose keychain holds that registry's key.
 */
export function startRegistrySigner(
  options: Pick<ServerOptions, "machineAccount" | "remoteConfig" | "log">,
  keychain: RegistryKeychain = osKeychain(),
) {
  const account = options.machineAccount;
  if (!account) return undefined;
  const base = new URL(options.remoteConfig?.marketUrl ?? marketOrigin);
  const loop = registrySignerLoop({
    org: () => account.ownerOrg(),
    keychain,
    sign: (org) =>
      signRegistry(
        {
          keychain,
          fetch: (path, init) => fetch(new URL(path, base), init),
          now: Date.now,
          trusted: shippedMarketKeys,
        },
        org,
      ),
    delay: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
    log: (message) => options.log?.(new Error(message)),
  });
  loop.start();
  return loop;
}
