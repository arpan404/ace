import { createHash } from "node:crypto";
import { designTokens } from "@ace/design-tokens";
import { chartSeries } from "@ace/themes";
import type { BrowserService } from "@ace/browser";
import type { HtmlTheme } from "@ace/html";
import {
  htmlPreviewToolkit,
  type HtmlLayoutPort,
  type HtmlPreviewPort,
  type HtmlPreviewResult,
} from "@ace/mcp-server";
import type { HtmlColorScheme, HtmlDiagnostics, HtmlMode } from "@ace/protocol";

type Diagnostic = HtmlDiagnostics["diagnostics"][number];

/**
 * The page variables the app's default theme gives a visualization, from the shared design
 * tokens. Variables the tokens don't carry keep the style kit's own fallbacks.
 */
export function previewTheme(scheme: HtmlColorScheme): HtmlTheme {
  const { colours, statusText } = designTokens.schemes[scheme];
  return {
    colorScheme: scheme,
    background: colours.background,
    foreground: colours.foreground,
    "card-foreground": colours.foreground,
    "muted-foreground": colours.mutedForeground,
    "subtle-foreground": colours.subtleForeground,
    card: colours.card,
    muted: colours.fill,
    hover: colours.fill,
    border: colours.separator,
    primary: colours.foreground,
    "primary-foreground": colours.background,
    accent: colours.accent,
    "accent-foreground": colours.onAccent,
    "accent-text": colours.accent,
    destructive: statusText.failed,
    success: statusText.done,
    warning: statusText.needsYou,
    info: statusText.working,
    ...Object.fromEntries(
      chartSeries(scheme).map((colour, index) => [`chart-${index + 1}`, colour]),
    ),
    radius: "8px",
    "font-sans":
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
    "font-mono": '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
  };
}

/** The page in the transcript's own document, captured by ace's hidden Chrome at each width. */
export async function previewHtml(
  service: Pick<BrowserService, "previewPage">,
  page: Parameters<HtmlPreviewPort["preview"]>[0],
  signal: AbortSignal,
): Promise<HtmlPreviewResult> {
  // parse5 loads on the first preview, not at daemon start.
  const {
    inlineVisualizationUrl,
    measuredLayoutProblems,
    phoneWidth,
    previewMaxHeight,
    previewMeasure,
    previewReport,
    styleKitVersion,
  } = await import("@ace/html");
  const theme = previewTheme(page.scheme);
  const shots = await service.previewPage({
    url: inlineVisualizationUrl(page.html, theme, page.mode, styleKitVersion),
    widths: page.widths,
    scheme: page.scheme,
    background: theme.background ?? "transparent",
    maxHeight: previewMaxHeight,
    measure: previewMeasure,
    signal,
  });
  const phone = shots.find((shot) => shot.width === phoneWidth);
  return {
    ...(phone ? { problems: measuredLayoutProblems(phone.measured) } : {}),
    report: previewReport(
      shots.map((shot) => ({
        width: shot.width,
        contentHeight: shot.contentHeight,
        imageHeight: shot.height,
        facts: shot.measured,
      })),
    ),
    images: shots.map((shot) => ({ width: shot.width, mimeType: shot.mimeType, data: shot.data })),
  };
}

/**
 * Phone-width problems of pages laid out recently, by exact document and mode, so publishing a
 * page just previewed doesn't lay it out again. Oldest forgotten first.
 */
export class MeasuredLayouts {
  private entries = new Map<string, Diagnostic[]>();
  private limit: number;
  constructor(limit = 32) {
    this.limit = limit;
  }
  private key(html: string, mode: HtmlMode): string {
    return createHash("sha256").update(mode).update("\0").update(html).digest("hex");
  }
  recall(html: string, mode: HtmlMode): Diagnostic[] | undefined {
    return this.entries.get(this.key(html, mode));
  }
  remember(html: string, mode: HtmlMode, problems: Diagnostic[]): void {
    const key = this.key(html, mode);
    this.entries.delete(key);
    this.entries.set(key, problems);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
  }
}

/** html_preview, through whichever browser service the daemon is running. */
export function htmlPreview(browser: () => BrowserService | undefined, layouts: MeasuredLayouts) {
  return htmlPreviewToolkit({
    async preview(page, signal) {
      const service = browser();
      if (!service) throw new Error("HTML preview unavailable: ace's browser is not running");
      const result = await previewHtml(service, page, signal);
      if (result.problems) layouts.remember(page.html, page.mode, result.problems);
      return result;
    },
  });
}

/**
 * The phone-width check html_render runs before publishing: the preview's result for this exact
 * page, else a layout at 360 px within `budgetMs`. A browser that is missing, slow to start or
 * fails gives `undefined`, and publishing falls back to its guess from the markup.
 */
export function htmlLayout(
  browser: () => BrowserService | undefined,
  layouts: MeasuredLayouts,
  budgetMs = 10_000,
): HtmlLayoutPort {
  return {
    async measure(page, signal) {
      const known = layouts.recall(page.html, page.mode);
      if (known) return known;
      const service = browser();
      if (!service) return undefined;
      try {
        const { phoneWidth } = await import("@ace/html");
        const { problems } = await previewHtml(
          service,
          { ...page, scheme: "dark", widths: [phoneWidth] },
          AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]),
        );
        if (problems) layouts.remember(page.html, page.mode, problems);
        return problems;
      } catch (error) {
        if (signal.aborted) throw error;
        return undefined;
      }
    },
  };
}
