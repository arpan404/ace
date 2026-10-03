import type { createPreviewGateway, GatewayOptions } from "@ace/preview";
import type { Store } from "./store.ts";
import { allows } from "./devices.ts";

export type DaemonPreviewOptions = Omit<GatewayOptions, "authority" | "now">;
export type DaemonPreview = Awaited<ReturnType<typeof createPreviewGateway>>;

/** A preview session permits app mutations, so it requires paired operate authority. */
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
        const device = store.devices.get(id);
        return device !== undefined && device.revokedAt === null && allows(device, "operate");
      },
    },
  });
}
