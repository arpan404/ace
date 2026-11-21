import * as z from "zod/mini";
import type { OpenRequest, WorkspaceTab } from "@/lib/workspace/index.ts";

/*
 * A device tab's panel state (ADR 0194): a page the person opened, in the desktop app, on a
 * remote machine's thread. It runs on this computer, so it lives only in this window's panel,
 * never on the daemon: agents don't see it. Small, so the thread's tab kinds can read it before
 * the tab's code loads.
 */

export const deviceTabKind = "device-browser";

export const DeviceTabData = z.object({
  /** The machine whose localhost the page reaches: its listing id. */
  machine: z.string().check(z.minLength(1), z.maxLength(256)),
  /** The page's address and title as the view last reported them. */
  url: z.string().check(z.minLength(1), z.maxLength(8192)),
  title: z.optional(z.string().check(z.maxLength(1024))),
});
export type DeviceTabData = z.infer<typeof DeviceTabData>;

export function deviceTabData(tab: WorkspaceTab | undefined): DeviceTabData | undefined {
  const parsed = DeviceTabData.safeParse(tab?.data);
  return parsed.success ? parsed.data : undefined;
}

/** A new device tab at `url` on `machine`, under a fresh id. */
export function deviceTabRequest(machine: string, url: string, id: string): OpenRequest {
  return { kind: deviceTabKind, id, data: { machine, url } satisfies DeviceTabData };
}
