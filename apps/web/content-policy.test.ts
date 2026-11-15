import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { hostedPolicy, unhashedInlineScripts } from "./content-policy.ts";
import { withHints } from "./route-preloads.ts";

const directives = (policy: string) =>
  new Map(
    policy.split("; ").map((directive) => {
      const [name = "", ...values] = directive.split(" ");
      return [name, values] as const;
    }),
  );

test("the hosted page runs only its own scripts: its inline boot scripts by hash, nothing else inline", () => {
  const html = readFileSync(join(import.meta.dirname, "index.html"), "utf8");
  const policy = directives(hostedPolicy(html));
  const scripts = policy.get("script-src") ?? [];
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  expect(inline.length).toBeGreaterThan(0);
  for (const [, body] of inline)
    expect(scripts).toContain(
      `'sha256-${createHash("sha256")
        .update(body ?? "")
        .digest("base64")}'`,
    );
  expect(scripts).not.toContain("'unsafe-inline'");
  expect(scripts).not.toContain("'unsafe-eval'");
  expect(policy.get("object-src")).toEqual(["'none'"]);
  // Pictures and recordings come from the page itself, never from another site.
  expect(policy.get("img-src")).toContain("data:");
  expect(policy.get("img-src")).not.toContain("https:");
  // A page can't set frame-ancestors; the host sends it.
  expect(policy.has("frame-ancestors")).toBe(false);
  // Cloudflare Pages sends the headers in `public/_headers` with every page it serves.
  const host = readFileSync(join(import.meta.dirname, "public", "_headers"), "utf8");
  expect(host).toContain("Content-Security-Policy: frame-ancestors 'none'");
  expect(host).toContain("X-Content-Type-Options: nosniff");
});

/** The page as the build writes it: the policy meta prepended to the final HTML. */
const built = (html: string) =>
  html.replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="${hostedPolicy(html).replaceAll("'", "&#39;")}">`,
  );

test("a built page with the route preload script allows it by hash, and a script changed after the policy is caught", () => {
  const source = readFileSync(join(import.meta.dirname, "index.html"), "utf8");
  const hinted = withHints(
    source,
    { initial: ["assets/initial.js"], routes: [{ path: "^/t/", files: ["assets/thread.js"] }] },
    "/",
  );
  const page = built(hinted);
  expect(unhashedInlineScripts(page)).toEqual([]);
  const changedLater = page.replace("var routes = ", "var routes = /* later */ ");
  expect(unhashedInlineScripts(changedLater)).toHaveLength(1);
});
