import { useEffect, useState } from "react";
import type { HtmlMode } from "@ace/protocol";
import { visualizationUrl, visualizationWindow, type HtmlTheme } from "@ace/html";
import { useToast } from "@/components/ui/toast.tsx";
import { desktopVisualizations } from "@/boot/desktop-visualizations.ts";

/**
 * What a shown page offers wherever it is drawn (inline in the reply or in the side panel):
 * open in its own window, copy the authored source, download it. Every form keeps the page's
 * sandbox and CSP around it.
 */
export function usePageActions(page: {
  html: string | undefined;
  title: string;
  theme: HtmlTheme;
  mode: HtmlMode;
}) {
  const { html, title, theme, mode } = page;
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const blobUrl = (source: string) =>
    URL.createObjectURL(
      new Blob([visualizationWindow(source, theme, mode)], { type: "text/html" }),
    );
  return {
    copied,
    open() {
      if (!html) return;
      const desktop = desktopVisualizations();
      if (desktop) {
        void desktop
          .open({ title, url: visualizationUrl(html, theme, mode) })
          .catch(() => toast.error({ title: "Couldn't open the visualization" }));
        return;
      }
      const url = blobUrl(html);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    copy() {
      if (!html) return;
      void navigator.clipboard
        .writeText(html)
        .then(() => setCopied(true))
        .catch(() => toast.error({ title: "Couldn't copy the source" }));
    },
    save() {
      if (!html) return;
      const url = blobUrl(html);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${fileName(title)}.html`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
  };
}

/** A download name from the page's title ("Binary search, step by step" → "binary-search-step-by-step"). */
export function fileName(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "visualization";
}
