import { vi } from "vitest";
import { z } from "zod";
import type { ConformancePage } from "./engine.ts";

export const Snapshot = z.object({
  nodes: z.array(
    z.object({
      ref: z.string().optional(),
      role: z.string(),
      name: z.string(),
      value: z.string().optional(),
    }),
  ),
});

export const TabList = z.object({
  activeTabId: z.string(),
  tabs: z.array(z.object({ tabId: z.string(), url: z.string(), title: z.string().optional() })),
});

/** The ref of the first actionable node named `name` in a snapshot. */
export function ref(snapshot: unknown, name: string): string {
  const found = Snapshot.parse(snapshot).nodes.find((node) => node.name === name && node.ref);
  if (!found?.ref) throw new Error(`No ref for "${name}" in the snapshot`);
  return found.ref;
}

/** Retries `check` until it stops throwing; real browsers settle on their own schedule. */
export function eventually<T>(check: () => T | Promise<T>, timeout = 20_000): Promise<T> {
  return vi.waitFor(check, { timeout, interval: 50 });
}

export async function tabs(page: ConformancePage) {
  return TabList.parse(await page.execute({ action: "tabs" }));
}

/** Navigates and waits for `text`, so later refs are taken from the settled document. */
export async function visit(page: ConformancePage, path: string, text: string, tabId?: string) {
  const at = tabId ? { tabId } : {};
  await page.execute({ action: "navigate", url: page.site.origin + path, ...at });
  await page.execute({ action: "wait_for", text, ...at });
}

/** Pixel size from a PNG's IHDR chunk. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(1, 4).toString("latin1") !== "PNG") throw new Error("Not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
