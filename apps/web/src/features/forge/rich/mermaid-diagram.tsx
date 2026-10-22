import { useEffect, useState, type ReactNode } from "react";
import { useTheme } from "@/theme/theme-provider.tsx";

/*
 * Mermaid diagrams in forge text (ADR 0096), drawn as GitHub draws them. The renderer loads as
 * its own chunk, only when a page shows a ```mermaid block. The diagram's own configuration
 * (`%%{init}%%` directives, front matter) is removed before it renders, and every setting that
 * could turn on HTML labels, change the security level or restyle it is locked, so it always
 * renders at mermaid's strictest level with plain-text labels. It renders one at a time, in a
 * container of its own that is removed afterwards, and its SVG is shown only as an `<img>` from a
 * `data:` URL: nothing in it runs in the page, and opened on its own it has no origin. The code
 * block stays while it loads, and if it can't be drawn.
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
function renderMermaid(source: string, scheme: "light" | "dark"): Promise<string> {
  const clean = diagramSource(source);
  if (clean.length > maxSource || !clean.trim())
    return Promise.reject(new Error("Not a diagram to draw"));
  const next = queue.then(() => renderOne(clean, scheme));
  queue = next.catch(() => {});
  return next;
}

function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export function MermaidDiagram(props: { source: string; code: ReactNode }): ReactNode {
  const scheme = useTheme().resolved.scheme;
  const key = `${scheme}\u0000${props.source}`;
  const [drawn, setDrawn] = useState<{ key: string; url: string }>();
  useEffect(() => {
    let live = true;
    renderMermaid(props.source, scheme).then(
      (svg) => {
        if (live) setDrawn({ key, url: svgDataUrl(svg) });
      },
      () => {
        // Not a diagram mermaid can draw: the code block stays.
      },
    );
    return () => {
      live = false;
    };
    // `key` names the source and scheme.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (drawn?.key !== key) return props.code;
  return (
    <img
      src={drawn.url}
      alt="Diagram"
      draggable={false}
      className="block h-auto max-w-full"
      data-diagram="mermaid"
    />
  );
}
