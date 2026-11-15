import type { SuitDetail } from "@ace/protocol/suits";
import { suitSheets } from "@/theme/suits/suit-css.ts";

/*
 * The stylesheet inside a Suit's miniature (`suit-preview.tsx`). The miniature lives in a shadow
 * root, so neither the app's own utilities nor the Suit on screen reach it; this sheet is all it
 * has: the miniature's plain look in `@layer components` (a Suit's `@layer suit` and ace's guard
 * come after it, as in the app), then the Suit's own sheets exactly as the app applies them.
 * Pure.
 */

/** The miniature's window, CSS px: laid out at a real size, then scaled to fit its card. */
export const previewWidth = 960;
export const previewHeight = 540;

/**
 * The shared tokens that derive from a Suit's scales. On the page they are computed on `<html>`
 * (styles/tokens.css, styles/motion.css); here they are recomputed on the miniature's root, so
 * its own `--radius-scale` and `--motion-scale` count.
 */
const derivedTokens = [
  "--radius-xs:calc(4px * var(--radius-scale, 1))",
  "--radius-sm:calc(6px * var(--radius-scale, 1))",
  "--radius:calc(8px * var(--radius-scale, 1))",
  "--radius-lg:calc(12px * var(--radius-scale, 1))",
  "--radius-xl:calc(18px * var(--radius-scale, 1))",
  "--motion-fast:calc(120ms * var(--motion-scale, 1))",
  "--motion-base:calc(200ms * var(--motion-scale, 1))",
].join(";");

const hairline = "var(--border-weight, 1px) solid var(--border)";

/** The miniature's own look: ace's shell in plain CSS, read from the Suit's tokens. */
const baseSheet = `@layer theme, base, components, utilities, suit, guard;
@layer components{
:host{all:initial;display:block;position:absolute;inset:0;overflow:hidden;contain:strict}
.frame{${derivedTokens};position:absolute;left:0;top:0;width:${previewWidth}px;height:${previewHeight}px;transform-origin:0 0;font:13px/1.4 var(--font-sans);color:var(--foreground);-webkit-font-smoothing:antialiased;pointer-events:none;user-select:none}
.frame *,.frame *::before,.frame *::after{box-sizing:border-box}
[data-part="app"]{position:absolute;inset:0;display:flex;background:var(--sidebar);overflow:hidden}
[data-part="rail"]{width:52px;flex:none;display:flex;flex-direction:column;align-items:center;gap:10px;padding:44px 0 12px}
[data-part="rail-item"]{width:30px;height:30px;border-radius:var(--radius);display:grid;place-items:center;color:var(--muted-foreground)}
[data-part="rail-item"][data-state="active"]{background:var(--active);color:var(--foreground)}
[data-part="rail-item"] i{width:14px;height:14px;border-radius:4px;border:1.5px solid currentColor}
[data-part="sidebar"]{position:relative;width:240px;flex:none;display:flex;flex-direction:column;padding:8px 6px 0 0}
[data-part="sidebar-header"]{display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;font-weight:600}
[data-part="sidebar-header"] [data-ornament]{max-height:28px;overflow:hidden}
[data-part="sidebar-header"] [data-ornament] svg{max-height:28px;max-width:100%}
[data-part="thread-list"]{display:flex;flex-direction:column;gap:2px;padding:6px 4px}
[data-part="thread-row"]{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;border-radius:var(--radius);color:var(--muted-foreground)}
[data-part="thread-row"][data-state="active"]{background:var(--active);color:var(--foreground)}
[data-part="thread-title"]{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-part="thread-meta"]{font-size:11px;color:var(--subtle-foreground)}
[data-part="status-icon"]{width:8px;height:8px;flex:none;border-radius:50%;background:currentColor}
[data-part="status-icon"][data-state="working"]{color:var(--status-working)}
[data-part="status-icon"][data-state="waiting"]{color:var(--status-waiting)}
[data-part="status-icon"][data-state="done"]{color:var(--status-done)}
[data-part="sidebar-footer"]{margin-top:auto;height:28px}
[data-part="main"]{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;margin:8px 8px 8px 0;border-radius:var(--radius-lg);background:var(--background);border:${hairline};overflow:hidden}
[data-part="header"]{display:flex;align-items:center;height:40px;padding:0 16px;border-bottom:${hairline}}
[data-part="header-title"]{font-weight:600}
[data-part="page"]{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
[data-part="transcript"]{flex:1;min-height:0;overflow:hidden;padding:18px 28px 0}
.column{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
[data-part="message-user"]{align-self:flex-end;max-width:70%;padding:8px 12px;border-radius:var(--radius-xl);background:var(--bubble);color:var(--foreground)}
[data-part="message-agent"]{font-family:var(--font-prose);line-height:1.55}
[data-part="message-agent"] p{margin:0}
[data-part="link"]{color:var(--ring-text, var(--ring));text-decoration:underline}
[data-part="tool-row"]{display:flex;align-items:center;gap:6px;color:var(--muted-foreground);font-size:12px}
[data-part="inline-code"]{font-family:var(--font-mono);font-size:11.5px;padding:1px 5px;border-radius:var(--radius-xs);background:var(--code)}
[data-part="working-line"]{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted-foreground)}
[data-part="composer"]{position:relative;margin:12px 28px 16px;padding:10px 10px 8px 14px;border-radius:var(--radius-xl);background:var(--popover);border:var(--border-weight, 1px) solid var(--border-strong)}
[data-part="composer-input"]{min-height:24px;color:var(--subtle-foreground)}
[data-part="composer-toolbar"]{display:flex;align-items:center;gap:8px;margin-top:4px}
[data-part="model-picker"]{font-size:12px;color:var(--muted-foreground)}
[data-part="composer-send"]{margin-left:auto;min-width:28px;height:28px;padding:0 8px;border:0;border-radius:999px;display:grid;place-items:center;background:var(--ring);color:var(--ring-foreground);font:600 12px var(--font-sans)}
[data-ornament^="corner-"]{position:absolute;width:160px;height:160px;overflow:hidden}
[data-ornament="corner-top-left"]{top:0;left:0}
[data-ornament="corner-top-right"]{top:0;right:0}
[data-ornament="corner-bottom-left"]{bottom:0;left:0}
[data-ornament="corner-bottom-right"]{bottom:0;right:0}
[data-ornament] svg,[data-ornament] img{max-width:100%;max-height:100%}
}`;

/** Everything the miniature of `detail` draws with: its plain look, then the Suit's own sheets. */
export function suitPreviewSheet(detail: Pick<SuitDetail, "manifest" | "assets" | "css">): string {
  return `${baseSheet}\n${suitSheets(detail)}`;
}
