import { z } from "zod";
import type { BrowserCertificateError } from "@ace/protocol";
import type { BrowserCdp } from "./backend.ts";

const Navigated = z.object({
  frame: z.object({ id: z.string(), url: z.string(), parentId: z.string().optional() }),
});
const Requested = z.object({
  requestId: z.string(),
  frameId: z.string().optional(),
  type: z.literal("Document"),
  request: z.object({ url: z.string() }),
});
const Failed = z.object({ requestId: z.string(), errorText: z.string() });
const certificateError = /^net::(ERR_CERT_[A-Z_]+)$/;

/**
 * The certificate error a tab's main document failed with, from its network events: the address
 * the person meant to open and Chromium's error name. It ends when the tab commits a real page.
 * The engines' error pages (`chrome-error://`) do not end it.
 */
export function certificateErrors(cdp: BrowserCdp, changed: () => void) {
  let mainFrame: string | undefined;
  let current: BrowserCertificateError | undefined;
  const documents = new Map<string, string>();
  const stops: (() => void)[] = [];
  const on = (method: string, listener: (raw: unknown) => void) => {
    cdp.on(method, listener);
    stops.push(() => cdp.off(method, listener));
  };
  on("Page.frameNavigated", (raw) => {
    const parsed = Navigated.safeParse(raw);
    if (!parsed.success || parsed.data.frame.parentId) return;
    mainFrame = parsed.data.frame.id;
    if (current && !parsed.data.frame.url.startsWith("chrome-error:")) {
      current = undefined;
      changed();
    }
  });
  on("Network.requestWillBeSent", (raw) => {
    const parsed = Requested.safeParse(raw);
    if (!parsed.success || (mainFrame && parsed.data.frameId !== mainFrame)) return;
    if (documents.size >= 64) documents.delete(documents.keys().next().value ?? "");
    documents.set(parsed.data.requestId, parsed.data.request.url);
  });
  on("Network.loadingFailed", (raw) => {
    const parsed = Failed.safeParse(raw);
    if (!parsed.success) return;
    const url = documents.get(parsed.data.requestId);
    documents.delete(parsed.data.requestId);
    const error = certificateError.exec(parsed.data.errorText)?.[1];
    if (url === undefined || !error) return;
    current = { url: url.slice(0, 8192), error };
    changed();
  });
  return {
    read: (): BrowserCertificateError | undefined => current,
    /** Throws unless the tab still shows the certificate error the person saw for `url`. */
    expect(url: string): BrowserCertificateError {
      if (!current || current.url !== url) throw new Error("Certificate error no longer shown");
      return current;
    },
    close: () => stops.forEach((stop) => stop()),
  };
}
