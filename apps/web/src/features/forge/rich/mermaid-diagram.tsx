import { useEffect, useState, type ReactNode } from "react";
import { useTheme } from "@/theme/theme-provider.tsx";

/*
 * Mermaid diagrams in forge text (ADR 0096), drawn as GitHub draws them. The renderer loads as
 * its own chunk, only when a page shows a ```mermaid block, and runs at its strictest security
 * level with plain-text labels. Its SVG is shown only as an `<img>` from a blob, where nothing in
 * it can run or reach the page. The code block stays while it loads, and if it can't be drawn.
 */

type Mermaid = (typeof import("mermaid"))["default"];
let loading: Promise<Mermaid> | undefined;
let renders = 0;
/** Mermaid's own limit on a diagram's text is 50,000 characters; past it, the code stays. */
const maxSource = 50_000;

async function renderMermaid(source: string, scheme: "light" | "dark"): Promise<string> {
  if (source.length > maxSource) throw new Error("Diagram too large");
  const mermaid = await (loading ??= import("mermaid").then((module) => module.default));
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: scheme === "dark" ? "dark" : "default",
  });
  const { svg } = await mermaid.render(`ace-mermaid-${++renders}`, source);
  return svg;
}

export function MermaidDiagram(props: { source: string; code: ReactNode }): ReactNode {
  const scheme = useTheme().resolved.scheme;
  const key = `${scheme}\u0000${props.source}`;
  const [drawn, setDrawn] = useState<{ key: string; url: string }>();
  useEffect(() => {
    let live = true;
    let url: string | undefined;
    renderMermaid(props.source, scheme).then(
      (svg) => {
        if (!live) return;
        url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        setDrawn({ key, url });
      },
      () => {
        // Not a diagram mermaid can draw: the code block stays.
      },
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
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
