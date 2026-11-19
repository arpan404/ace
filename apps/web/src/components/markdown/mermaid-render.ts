/*
 * Mermaid diagrams, drawn as GitHub draws them, for forge text and agent prose (ADR 0096). The
 * renderer loads as its own chunk, only when a ```mermaid block is drawn. The diagram's own
 * configuration (`%%{init}%%` directives, front matter) is removed before it renders, and every
 * setting that could turn on HTML labels, change the security level or restyle it is locked, so
 * it always renders at mermaid's strictest level with plain-text labels. It renders one at a
 * time, in a container of its own that is removed afterwards, and its SVG is shown only as an
 * `<img>` from a `data:` URL: nothing in it runs in the page, and opened on its own it has no
 * origin.
 */

type Mermaid = (typeof import("mermaid"))["default"];
let loading: Promise<Mermaid> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let renders = 0;
/** Mermaid's own limit on a diagram's text is 50,000 characters; past it, the code stays. */
const maxSource = 50_000;
/** Settings a diagram can never change. */
const locked = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "htmlLabels",
  "flowchart",
  "theme",
  "themeVariables",
  "themeCSS",
  "fontFamily",
  "dompurifyConfig",
  "deterministicIds",
];

/** A diagram's text without the configuration it carries: init directives and front matter. */
export function diagramSource(source: string): string {
  return source
    .replace(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
    .replace(/%%\{[\s\S]*?\}%%/g, "");
}

async function renderOne(source: string, scheme: "light" | "dark"): Promise<string> {
  const mermaid = await (loading ??= import("mermaid").then((module) => module.default));
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    theme: scheme === "dark" ? "dark" : "default",
    secure: locked,
  });
  // Its working copy goes in a container of ours, off screen and inert, and goes with it.
  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.inert = true;
  container.style.cssText = "position:fixed;left:-10000px;top:0;width:1024px;visibility:hidden";
  document.body.append(container);
  try {
    const { svg } = await mermaid.render(`ace-mermaid-${++renders}`, source, container);
    return svg;
  } finally {
    container.remove();
  }
}

/** Renders one at a time: mermaid's settings are global, so a theme switch can't cross two. */
export function renderMermaid(source: string, scheme: "light" | "dark"): Promise<string> {
  const clean = diagramSource(source);
  if (clean.length > maxSource || !clean.trim())
    return Promise.reject(new Error("Not a diagram to draw"));
  const next = queue.then(() => renderOne(clean, scheme));
  queue = next.catch(() => {});
  return next;
}

export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
