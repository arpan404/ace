import { z } from "zod";
import type { BrowserCdp } from "./backend.ts";

/** Document progress follows links and history as well as explicit navigation commands. */
export function pageStatus(cdp: BrowserCdp, changed: () => void) {
  let mainFrame: string | undefined;
  let loading = false;
  const documents = new Map<string, string>();
  let loadError: string | undefined;
  let permissionDenied: { origin: string; permission: string } | undefined;
  const stops: (() => void)[] = [];
  const on = (method: string, work: (raw: unknown) => void) => {
    cdp.on(method, work);
    stops.push(() => cdp.off(method, work));
  };
  on("Page.frameNavigated", (raw) => {
    const nav = z
      .object({ frame: z.object({ id: z.string(), parentId: z.string().optional() }) })
      .safeParse(raw);
    if (nav.success && !nav.data.frame.parentId) mainFrame = nav.data.frame.id;
  });
  for (const method of ["Page.frameStartedLoading", "Page.frameStoppedLoading"])
    on(method, (raw) => {
      const frame = z.object({ frameId: z.string() }).safeParse(raw);
      if (!frame.success || (mainFrame && frame.data.frameId !== mainFrame)) return;
      loading = method === "Page.frameStartedLoading";
      if (loading) {
        loadError = undefined;
        permissionDenied = undefined;
      }
      changed();
    });
  on("Network.requestWillBeSent", (raw) => {
    const request = z
      .object({ requestId: z.string(), frameId: z.string(), type: z.literal("Document") })
      .safeParse(raw);
    if (!request.success) return;
    if (documents.size >= 64) documents.delete(documents.keys().next().value ?? "");
    documents.set(request.data.requestId, request.data.frameId);
  });
  on("Network.loadingFinished", (raw) => {
    const request = z.object({ requestId: z.string() }).safeParse(raw);
    if (request.success) documents.delete(request.data.requestId);
  });
  on("Network.loadingFailed", (raw) => {
    const failed = z
      .object({
        requestId: z.string(),
        type: z.literal("Document"),
        errorText: z.string(),
        canceled: z.boolean().optional(),
      })
      .safeParse(raw);
    if (!failed.success) return;
    const frame = documents.get(failed.data.requestId);
    documents.delete(failed.data.requestId);
    if (!frame || failed.data.canceled || (mainFrame && frame !== mainFrame)) return;
    loading = false;
    loadError = failed.data.errorText.slice(0, 2048);
    changed();
  });
  on("ace.permissionDenied", (raw) => {
    const denied = z
      .object({ permission: z.string().max(256), origin: z.string().max(8192) })
      .safeParse(raw);
    if (!denied.success) return;
    permissionDenied = denied.data;
    changed();
  });
  return {
    read: () => ({ loading, loadError, permissionDenied }),
    close: () => stops.forEach((stop) => stop()),
  };
}
