/*
 * The page /authorize shows (ADR 0117, Consent). It decides nothing: it names the client, where
 * the sign-in returns to, what it asks for and the match code, and says where to approve. It
 * works under ace's relay sandbox: no script, no cookies, no storage, no external assets; while
 * it waits it reloads its own URL, which carries its state. Every value is escaped.
 */
import type { OutsideScope } from "@ace/protocol";

const scopeWords: Record<OutsideScope, string> = {
  "threads:read": "See projects, models and threads",
  "threads:start": "Start threads",
  "threads:message": "Message and steer threads",
  "threads:stop": "Stop threads",
  browser: "Use ace's browser",
  computer: "Use this computer's screen",
};
export const waitRefreshSeconds = 2;

export interface ConsentView {
  clientName: string;
  /** The verified domain; null: unverified (DCR). */
  domain: string | null;
  /** Where the code goes: a host, or an app's own scheme. */
  redirectHost: string;
  /** `this-device`: an app on the device signing in, which nothing vouches for. */
  redirectKind: "web" | "this-device";
  scopes: readonly OutsideScope[];
  matchCode: string;
  machine: string;
}

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
const style = `
:root{color-scheme:light dark;--fg:#1d1f23;--muted:#5d636d;--subtle:#7a808a;--bg:#fbfbfa;--needs:#AD7200;--failed:#C93A33}
@media (prefers-color-scheme:dark){:root{--fg:#ececee;--muted:#a3a8b0;--subtle:#7e8692;--bg:#17181b;--needs:#EDB250;--failed:#F47670}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:440px;margin:0 auto;padding:64px 24px}
h1{font-size:22px;font-weight:600;line-height:1.3;margin:0 0 8px}
p{margin:0 0 8px}.muted{color:var(--muted)}.subtle{color:var(--subtle);font-size:13px}
ul{margin:24px 0;padding:0;list-style:none}li{margin:0 0 4px}
.code{font:600 28px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;margin:24px 0 8px}
.needs{color:var(--needs)}.failed{color:var(--failed)}`;

function page(title: string, body: string, refresh: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">${refresh ? `<meta http-equiv="refresh" content="${waitRefreshSeconds}">` : ""}<title>${escape(title)}</title><style>${style}</style></head><body><main>${body}</main></body></html>`;
}

/** The waiting page: what is asked and where to approve it. Reloads itself until decided. */
export function consentPage(view: ConsentView): string {
  const who = view.domain
    ? `<p class="muted">${escape(view.domain)}</p>`
    : `<p class="muted">Unverified client</p>`;
  const returns =
    view.redirectKind === "this-device"
      ? `<p class="subtle">Returns to an app on this device (${escape(view.redirectHost)}). Approve only if you started this sign-in.</p>`
      : `<p class="subtle">Returns to ${escape(view.redirectHost)}</p>`;
  const scopes = view.scopes.map((scope) => `<li>${escape(scopeWords[scope])}</li>`).join("");
  return page(
    `Sign in to ace on ${view.machine}`,
    `<h1>${escape(view.clientName)} wants to use ace on ${escape(view.machine)}</h1>${who}<ul>${scopes}</ul><p class="code">${escape(view.matchCode)}</p><p class="needs">Approve in ace on ${escape(view.machine)} if it shows this code.</p>${returns}`,
    true,
  );
}
/** A sign-in that can't go on, with what the person can do. */
export function endedPage(machine: string, sentence: string, failed: boolean): string {
  return page(
    `Sign in to ace on ${machine}`,
    `<h1>Sign in to ace on ${escape(machine)}</h1><p class="${failed ? "failed" : "muted"}">${escape(sentence)}</p>`,
    false,
  );
}
/**
 * Headers for every sign-in page: nothing loads or runs, nothing frames it, nothing keeps it.
 * ace's relay adds its own sandbox on top.
 */
export const pageHeaders: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
