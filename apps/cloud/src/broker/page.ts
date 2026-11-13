/**
 * The page the person's browser lands on after the maker redirects back. Plain words, no links,
 * no scripts, never cached, and no referrer, so the code in its address goes nowhere else.
 */
export type Page = "signed_in" | "declined" | "invalid";

const pages: Record<Page, { status: number; title: string; line: string }> = {
  signed_in: { status: 200, title: "Signed in", line: "Signed in. You can close this tab." },
  declined: {
    status: 200,
    title: "Sign-in cancelled",
    line: "The sign-in was cancelled. You can close this tab and try again from Spade.",
  },
  invalid: {
    status: 400,
    title: "Sign-in not found",
    line: "This sign-in has expired or was already used. Start again from Spade.",
  },
};

export function page(which: Page): Response {
  const { status, title, line } = pages[which];
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui,sans-serif;margin:20vh auto;max-width:28rem;padding:0 1rem;color:#222;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}}</style></head><body><p>${line}</p></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
