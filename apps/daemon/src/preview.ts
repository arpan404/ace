import type { createPreviewGateway, GatewayOptions } from "@ace/preview";
import type { Store } from "./store.ts";
import { allows } from "./devices.ts";

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
 * A preview session permits app mutations, so it requires operate authority: a paired operate
 * device (rechecked on every request), or the host credential through `hostPreviewIdentity`.
 * Device tokens alone never resolve to the host identity.
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
        const device = store.devices.authenticate(token, now());
        return allows(device, "operate") ? (device?.id ?? null) : null;
      },
      async isPaired(id) {
        if (id === hostPreviewIdentity) return true;
        const device = store.devices.get(id);
        return device !== undefined && device.revokedAt === null && allows(device, "operate");
      },
    },
  });
}
