import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PreviewRefusal } from "@ace/protocol/preview";

const explanations: Record<PreviewRefusal, string> = {
  signed_out: "This preview needs signing in. Open it again from ace.",
  session_expired: "This preview's sign-in expired. Open it again from ace.",
  link_invalid: "This sign-in link expired or was already used. Open the preview again from ace.",
  not_previewed: "Nothing is previewed at this address any more.",
  upstream_unavailable: "The dev server behind this preview didn't answer.",
};

/**
 * The page reads its status from its own body and tells a framing page (ace's preview panel)
 * through `postMessage`, so the embedder can explain a refusal it can't read across origins.
 * One fixed script, allowed by its hash; the message carries no credential.
 */
const script =
  'var d=document.body.dataset;parent!==window&&parent.postMessage({type:"ace-preview.status",status:+d.status,reason:d.reason},"*")';
const scriptHash = createHash("sha256").update(script).digest("base64");

/** Browsers mark navigations; fetches, scripts and images get the bare status as before. */
function navigation(req: IncomingMessage): boolean {
  return req.headers["sec-fetch-mode"] === "navigate";
}

/**
 * Ends a refused request. A navigation (top-level or framed) gets a small gateway-owned page
 * that names the reason; anything else gets the status alone. App responses are never touched.
 */
export function refuse(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  reason: PreviewRefusal,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (!navigation(req)) {
    res.writeHead(status, { "cache-control": "no-store" });
    res.end();
    return;
  }
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; script-src 'sha256-${scriptHash}'`,
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">` +
      `<title>Preview unavailable</title><body data-status="${status}" data-reason="${reason}">` +
      `<p>${explanations[reason]}</p><script>${script}</script>`,
  );
}
