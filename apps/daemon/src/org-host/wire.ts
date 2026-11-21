import { randomBytes } from "node:crypto";
import type { ServerOptions } from "../server-options.ts";
import { orgHostLink, type OrgHostLink } from "./link.ts";

/**
 * The org-host link for a daemon that has both an ace sign-in and Spade (ADR 0206): it runs
 * on every machine, and does nothing until the machine is an organization's host or its Spade
 * still belongs to one it no longer is.
 */
export function startOrgHost(options: ServerOptions): OrgHostLink | undefined {
  const account = options.machineAccount;
  const spade = options.spade;
  if (!account || !spade) return undefined;
  const link = orgHostLink({
    account,
    spade: {
      ready: () => spade.ready(),
      personKey: () => spade.personKey(),
      subscribe: (listener) => spade.subscribe(() => listener()),
    },
    fetch: options.orgHostFetch ?? globalThis.fetch,
    now: Date.now,
    nonce: () => randomBytes(16).toString("hex"),
    delay: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return () => clearTimeout(timer);
    },
    ...(options.orgHostIntervals ? { intervals: options.orgHostIntervals } : {}),
  });
  void link.start();
  return link;
}
