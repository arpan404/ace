import { designTokens } from "@ace/design-tokens";
import type { BrowserService } from "@ace/browser";
import {
  inlineVisualizationUrl,
  previewMaxHeight,
  previewMeasure,
  previewReport,
  previewWidths,
  styleKitVersion,
  type HtmlTheme,
} from "@ace/html";
import { htmlPreviewToolkit, type HtmlPreviewPort } from "@ace/mcp-server";
import type { HtmlColorScheme } from "@ace/protocol";

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
    radius: "8px",
    "font-sans":
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
    "font-mono": '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
  };
}

/** html_preview: the page in the transcript's own document, captured by ace's hidden Chrome. */
export function htmlPreview(browser: () => BrowserService | undefined) {
  const port: HtmlPreviewPort = {
    async preview(page, signal) {
      const service = browser();
      if (!service) throw new Error("HTML preview unavailable: ace's browser is not running");
      const theme = previewTheme(page.scheme);
      const shots = await service.previewPage({
        url: inlineVisualizationUrl(page.html, theme, page.mode, styleKitVersion),
        widths: previewWidths,
        scheme: page.scheme,
        background: theme.background ?? "transparent",
        maxHeight: previewMaxHeight,
        measure: previewMeasure,
        signal,
      });
      return {
        report: previewReport(
          shots.map((shot) => ({
            width: shot.width,
            contentHeight: shot.contentHeight,
            imageHeight: shot.height,
            facts: shot.measured,
          })),
        ),
        images: shots.map((shot) => ({
          width: shot.width,
          mimeType: shot.mimeType,
          data: shot.data,
        })),
      };
    },
  };
  return htmlPreviewToolkit(port);
}
