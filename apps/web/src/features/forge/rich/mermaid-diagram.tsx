import { useEffect, useState, type ReactNode } from "react";
import { useTheme } from "@/theme/theme-provider.tsx";
import { renderMermaid, svgDataUrl } from "@/components/markdown/mermaid-render.ts";

/*
 * A ```mermaid block in forge text (`mermaid-render.ts` draws it). The code block stays while it
 * loads, and if it can't be drawn.
 */

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
