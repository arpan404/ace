import { z } from "zod";

/*
 * The bridge contract of device tabs (ADR 0194): pages the person opens, in the desktop app,
 * on a remote machine's thread. Each runs in a native view on this computer, in its machine's
 * partition, with the machine's localhost reached through its tunnel.
 */

const TabId = z.string().min(1).max(128);
const MachineId = z.string().min(1).max(256);
const Url = z.string().min(1).max(8192);

export const DeviceTabOpen = z.object({
  tabId: TabId,
  machineId: MachineId,
  /** Loaded only when the tab has no view yet; a view kept from before shows as it is. */
  url: Url,
});

export const DeviceTabPlacement = z.object({
  tabId: TabId,
  /** In the page's CSS pixels, relative to the window's content. */
  bounds: z.object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().min(0).max(16384),
    height: z.number().min(0).max(16384),
  }),
  visible: z.boolean(),
});

export const DeviceTabGo = z.discriminatedUnion("action", [
  z.object({ tabId: TabId, action: z.literal("navigate"), url: Url }),
  z.object({ tabId: TabId, action: z.enum(["back", "forward", "reload", "stop"]) }),
]);

export const DeviceTabId = z.object({ tabId: TabId });

/** Why the machine's localhost didn't answer (see `TunnelFailure`). */
export const DeviceTabTunnelFailure = z.enum([
  "off",
  "forbidden",
  "refused",
  "limit",
  "offline",
  "closed",
  "failed",
]);

export const DeviceTabState = z.object({
  tabId: TabId,
  url: z.string().max(8192),
  title: z.string().max(1024),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  /** The last load failed; cleared by the next one that commits. */
  failure: z
    .object({
      url: z.string().max(8192),
      /** Chromium's net error code and name (`ERR_CONNECTION_REFUSED`). */
      code: z.number().int(),
      description: z.string().max(256),
      /** The machine's side of a loopback load, when the tunnel said why. */
      tunnel: DeviceTabTunnelFailure.optional(),
      port: z.number().int().min(1).max(65_535).optional(),
    })
    .optional(),
});
export type DeviceTabState = z.infer<typeof DeviceTabState>;

/** A link in a device tab asked for a new tab (`target=_blank`). */
export const DeviceTabOpenRequest = z.object({ from: TabId, url: Url });
