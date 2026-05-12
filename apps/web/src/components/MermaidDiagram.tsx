import { useEffect, useMemo, useReducer } from "react";

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

type MermaidRenderState =
  | { status: "idle" | "loading" | "ready"; renderedSvg: string | null; renderError: null }
  | { status: "error"; renderedSvg: null; renderError: string };

const IDLE_MERMAID_RENDER_STATE: MermaidRenderState = {
  status: "idle",
  renderedSvg: null,
  renderError: null,
};

const LOADING_MERMAID_RENDER_STATE: MermaidRenderState = {
  status: "loading",
  renderedSvg: null,
  renderError: null,
};

type MermaidRenderAction =
  | { type: "reset" }
  | { type: "start" }
  | { type: "success"; svg: string }
  | { type: "error"; message: string };

function mermaidRenderStateReducer(
  _state: MermaidRenderState,
  action: MermaidRenderAction,
): MermaidRenderState {
  switch (action.type) {
    case "reset":
      return IDLE_MERMAID_RENDER_STATE;
    case "start":
      return LOADING_MERMAID_RENDER_STATE;
    case "success":
      return {
        status: "ready",
        renderedSvg: action.svg,
        renderError: null,
      };
    case "error":
      return {
        status: "error",
        renderedSvg: null,
        renderError: action.message,
      };
  }
}

export default function MermaidDiagram({ source, theme, className }: MermaidDiagramProps) {
  const trimmedSource = useMemo(() => source.trim(), [source]);
  const [renderState, dispatchRenderState] = useReducer(
    mermaidRenderStateReducer,
    IDLE_MERMAID_RENDER_STATE,
  );
  const { renderedSvg, renderError } = renderState;

  useEffect(() => {
    if (trimmedSource.length === 0) {
      dispatchRenderState({ type: "reset" });
      return;
    }

    let cancelled = false;
    dispatchRenderState({ type: "start" });

    void renderMermaidToSvg(trimmedSource, theme)
      .then((svg) => {
        if (cancelled) {
          return;
        }
        dispatchRenderState({ type: "success", svg });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        dispatchRenderState({
          type: "error",
          message: error instanceof Error ? error.message : "Unable to render Mermaid diagram.",
        });
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
        Rendering Mermaid diagram…
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
