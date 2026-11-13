/**
 * The few HTML pages the account backend shows a browser during sign-in, in ace's look. They are
 * the only responses that allow inline CSS; none runs a script.
 */

// The ace mark's wing (apps/web/src/components/ace-mark.tsx) and its mirror image.
const wing =
  "M11.6 2C10.8 2 10.4 2.6 9.8 3.3L2.9 11.3C1.2 13.3 1.8 15.6 3.8 16.8L7.8 19.3C8.5 19.8 9.3 19.8 9.9 19.1L11 17.7C11.7 16.8 11.5 16.1 10.8 15.4L7.3 12.3C10.3 9.8 11.6 7.6 11.6 5V2Z";
const mark = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${wing}"/><path transform="translate(24 0) scale(-1 1)" d="${wing}"/></svg>`;

const style = [
  ":root{color-scheme:light dark;--bg:#FFFFFF;--fg:#222222}",
  "@media (prefers-color-scheme:dark){:root{--bg:#0C0C0C;--fg:#DEDEDE}}",
  "html,body{margin:0;height:100%}",
  'body{display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}',
  "main{max-width:22rem;padding:24px;text-align:center}",
  "svg{width:32px;height:32px}",
  "p{margin:16px 0 0}",
  "button{margin-top:24px;height:36px;padding:0 16px;border:0;border-radius:8px;background:var(--fg);color:var(--bg);font:inherit;font-weight:500;cursor:pointer}",
  "button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}",
].join("");

const basePolicy =
  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

function html(status: number, body: string, headers: Record<string, string>): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ace sign-in</title><style>${style}</style><body><main>${mark}${body}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } },
  );
}

/** A page with one sentence. `message` is ace's own text, never anything from a request. */
export function page(status: number, message: string): Response {
  return html(status, `<p>${message}</p>`, {
    "Content-Security-Policy": `${basePolicy}; form-action 'none'`,
  });
}

/**
 * GET of the sign-in link: one button that posts the login id to `/v1/account/login/continue`,
 * so a link preview or preloader that fetches the link spends nothing. The form may submit to
 * this origin and follow the redirect chain through WorkOS (any HTTPS host: AuthKit domains and
 * identity providers vary) back to the sign-in's return address. The referrer policy lets the
 * same-origin post carry its Origin, which the API checks.
 */
export function continuePage(id: string, returnOrigins: readonly string[]): Response {
  const targets = [
    "'self'",
    "https:",
    "ace:",
    ...returnOrigins.filter((o) => o.startsWith("http:")),
  ];
  return html(
    200,
    `<p>Sign in to ace with your browser.</p><form method="post" action="/v1/account/login/continue"><input type="hidden" name="id" value="${id}"><button type="submit">Continue to sign in</button></form>`,
    {
      "Content-Security-Policy": `${basePolicy}; form-action ${targets.join(" ")}`,
      "Referrer-Policy": "same-origin",
    },
  );
}
