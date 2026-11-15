import type { Plugin } from "vite";
import { contentSecurityPolicy, inlineScriptHashes } from "@ace/html/app-policy";

/**
 * The app's Content Security Policy written into the built page (ADR 0096), the same one the
 * desktop shell sends as a header, so a hosted build runs under it too: scripts only from the
 * bundle and the page's own inline boot scripts (by hash), nothing else inline, no plugins.
 * `frame-ancestors` can't be set from a page; the host sends it as a header (`public/_headers`, read by Cloudflare Pages).
 */
export function hostedPolicy(html: string): string {
  return contentSecurityPolicy({ inlineScripts: inlineScriptHashes(html), dynamicDaemons: true })
    .split("; ")
    .filter((directive) => !directive.startsWith("frame-ancestors"))
    .join("; ");
}

/**
 * Inline scripts of a built page that its own policy doesn't allow by hash. A page whose inline
 * script changed after the policy was written (a plugin that runs later) would ship with that
 * script blocked, so the build fails on any.
 */
export function unhashedInlineScripts(html: string): string[] {
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
  const policy = meta.replaceAll("&#39;", "'");
  const allowed = new Set(policy.match(/'sha256-[^']+'/g) ?? []);
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1] ?? "",
  );
  const hashes = inlineScriptHashes(html);
  return scripts.filter((_, index) => !allowed.has(`'${hashes[index]}'`));
}

export function contentPolicy(): Plugin {
  return {
    name: "ace-content-policy",
    apply: "build",
    // After every plugin's generateBundle, so the page checked is the one written.
    writeBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "asset" || !output.fileName.endsWith(".html")) continue;
        const html =
          typeof output.source === "string" ? output.source : Buffer.from(output.source).toString();
        const missing = unhashedInlineScripts(html);
        if (missing.length)
          this.error(
            `${output.fileName} has ${missing.length} inline script(s) its Content Security Policy doesn't allow; the policy must be written after every plugin that changes them.`,
          );
      }
    },
    transformIndexHtml: {
      order: "post",
      handler: (html) => ({
        html,
        tags: [
          {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: hostedPolicy(html) },
            injectTo: "head-prepend",
          },
        ],
      }),
    },
  };
}
