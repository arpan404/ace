import { createPreviewGateway, type GatewayOptions } from "@ace/preview";
import type { Store } from "./store.ts";

export type DaemonPreviewOptions = Omit<GatewayOptions, "authority" | "now">;
export type DaemonPreview = Awaited<ReturnType<typeof createPreviewGateway>>;

/** The host's local admin credential cannot mint a paired-device browser session. */
export function createDaemonPreview(
  store: Store,
  options: DaemonPreviewOptions,
  now: () => number,
): Promise<DaemonPreview> {
  return createPreviewGateway({
    ...options,
    now,
    authority: {
      async authorize(token) {
        return store.devices.authenticate(token, now())?.id ?? null;
      },
      async isPaired(id) {
        const device = store.devices.get(id);
        return device !== undefined && device.revokedAt === null;
      },
    },
  });
}
