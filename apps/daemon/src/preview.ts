import type { createPreviewGateway, GatewayOptions } from "@ace/preview";
import type { Store } from "./store.ts";
import { activeDevice, allows } from "./devices.ts";

export type DaemonPreviewOptions = Omit<GatewayOptions, "authority" | "now">;
export type DaemonPreview = Awaited<ReturnType<typeof createPreviewGateway>>;

/**
 * The identity a preview session carries when the daemon's own token file credential (the
 * desktop app, a local web app) signed it in over the loopback socket. The ":" keeps it apart
 * from every paired device id. It cannot be revoked short of a restart, which also replaces
 * the gateway's signing secret and so ends its sessions; holders of that token already
 * administer the daemon, so previewing grants them nothing new.
 */
export const hostPreviewIdentity = "host:local";

/**
 * The identity a paired device's preview session carries: the device and the generation of the
 * credential that opened it. Pairing the same install again replaces that credential, and every
 * link and session it signed stops passing (ADR 0115). Device ids hold no ":".
 */
export function pairedPreviewIdentity(device: string, generation: string): string {
  return `${device}:${generation}`;
}

/**
 * A preview session permits app mutations, so it requires operate authority: a paired operate
 * device still holding the credential that signed it in (rechecked on every request), or the
 * host credential through `hostPreviewIdentity`. Device tokens alone never resolve to the host
 * identity.
 */
export async function createDaemonPreview(
  store: Store,
  options: DaemonPreviewOptions,
  now: () => number,
): Promise<DaemonPreview> {
  const { createPreviewGateway } = await import("@ace/preview");
  return createPreviewGateway({
    ...options,
    now,
    authority: {
      async authorize(token) {
        // Authentication records last-seen bookkeeping, so it passes the write boundary.
        const device = await store.write(() => store.devices.authenticate(token, now()));
        return device && allows(device, "operate")
          ? pairedPreviewIdentity(device.id, device.generation)
          : null;
      },
      async isPaired(identity) {
        if (identity === hostPreviewIdentity) return true;
        const split = identity.lastIndexOf(":");
        if (split <= 0) return false;
        const device = store.devices.current(
          identity.slice(0, split),
          identity.slice(split + 1),
          now(),
        );
        return activeDevice(device, now()) && allows(device, "operate");
      },
    },
  });
}
