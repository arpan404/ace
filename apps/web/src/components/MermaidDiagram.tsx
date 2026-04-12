import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";

type MermaidTheme = "light" | "dark";
type MermaidApi = (typeof import("mermaid"))["default"];

let mermaidApiPromise: Promise<MermaidApi> | null = null;
let initializedTheme: MermaidTheme | null = null;
let renderSequence = 0;

function getMermaidApi(): Promise<MermaidApi> {
  if (mermaidApiPromise) {
    return mermaidApiPromise;
  }
  mermaidApiPromise = import("mermaid").then((module) => module.default);
  return mermaidApiPromise;
}

async function renderMermaidToSvg(source: string, theme: MermaidTheme): Promise<string> {
  const mermaid = await getMermaidApi();
  if (initializedTheme !== theme) {
    mermaid.initialize({
      securityLevel: "strict",
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "default",
    });
    initializedTheme = theme;
  }

  renderSequence += 1;
  const renderId = `ace-mermaid-${renderSequence.toString(36)}`;
  const { svg } = await mermaid.render(renderId, source);
  return svg;
}

interface MermaidDiagramProps {
  source: string;
  theme: MermaidTheme;
  className?: string;
}

export default function MermaidDiagram({ source, theme, className }: MermaidDiagramProps) {
  const trimmedSource = useMemo(() => source.trim(), [source]);
  const [renderedSvg, setRenderedSvg] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (trimmedSource.length === 0) {
      setRenderedSvg(null);
      setRenderError(null);
      return;
    }

    let cancelled = false;
    setRenderedSvg(null);
    setRenderError(null);

    void renderMermaidToSvg(trimmedSource, theme)
      .then((svg) => {
        if (cancelled) {
          return;
        }
        setRenderedSvg(svg);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setRenderError(
          error instanceof Error ? error.message : "Unable to render Mermaid diagram.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [theme, trimmedSource]);

  if (trimmedSource.length === 0) {
    return (
      <div
        className={cn(
          "flex min-h-[120px] items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/35 px-3 text-xs text-muted-foreground/75",
          className,
        )}
        data-mermaid-diagram-state="empty"
      >
        Mermaid source is empty.
      </div>
    );
  }

  if (renderError) {
    return (
      <div
        className={cn(
          "space-y-1 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs text-destructive/90",
          className,
        )}
        data-mermaid-diagram-state="error"
      >
        <p className="font-medium">Unable to render Mermaid diagram.</p>
        <p className="font-normal opacity-85">{renderError}</p>
      </div>
    );
  }

  if (!renderedSvg) {
    return (
      <div
        className={cn(
          "flex min-h-[120px] items-center justify-center rounded-lg border border-border/60 bg-muted/35 px-3 text-xs text-muted-foreground/75",
          className,
        )}
        data-mermaid-diagram-state="loading"
      >
        Rendering Mermaid diagram...
      </div>
    );
  }

  return (
    <div
      className={cn(
        "overflow-auto rounded-lg border border-border/60 bg-muted/35 p-2 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full",
        className,
      )}
      data-mermaid-diagram-state="ready"
      dangerouslySetInnerHTML={{ __html: renderedSvg }}
    />
  );
}
