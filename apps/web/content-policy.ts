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

export function contentPolicy(): Plugin {
  return {
    name: "ace-content-policy",
    apply: "build",
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
