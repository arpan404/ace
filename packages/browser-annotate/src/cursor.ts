import { designTokens } from "@ace/design-tokens";
import { agentCursorOutline, agentCursorPath, agentCursorTip } from "@ace/design-tokens/glyphs";
import { cursorBundle } from "./cursor-bundle.gen.ts";
import type { CursorInit, CursorOp, CursorStyle } from "./cursor-init.ts";
import { overlayTokens } from "./palette.ts";
import { secretFieldSelector } from "./secret-fields.ts";

export type { CursorOp, CursorStyle, CursorPoint, CursorRect } from "./cursor-init.ts";
export { maskedSecretValue, secretFieldSelector } from "./secret-fields.ts";

/**
 * The agent cursor as CDP expressions (ADR 0082, agent cursor). Every expression runs in the
 * isolated world named `cursorWorldName`; the page's own scripts see none of it. The layer has
 * no way out to the daemon: it only draws.
 */
export const cursorWorldName = "ace-cursor";

/** ace's own accent, used until a viewer reports the person's (`BrowserCaptureViewport.cursor`). */
export const defaultCursorStyle: CursorStyle = {
  fill: designTokens.schemes.light.colours.accent,
  outline: "#FFFFFF",
};

/** Bundle plus install: evaluates to the layer's document id. */
export function cursorInstallExpression(style: CursorStyle, glideMs: number): string {
  const tokens = overlayTokens();
  const init: CursorInit = {
    style,
    font: tokens.font,
    glideMs,
    motion: tokens.motion,
    glyph: { path: agentCursorPath, outline: agentCursorOutline, tip: agentCursorTip },
    secretSelector: secretFieldSelector,
  };
  return `${cursorBundle}\n;globalThis.aceCursorInstall(${JSON.stringify(init)});`;
}

/** Evaluates to whether a layer took the ops. */
export function cursorApplyExpression(ops: readonly CursorOp[]): string {
  return `(() => { const layer = globalThis.aceCursor; if (!layer) return false; for (const op of ${JSON.stringify(ops)}) layer.apply(op); return true; })()`;
}

/** A promise: resolves once the layer's last change reached the screen. */
export const cursorSettledExpression =
  "(async () => { const layer = globalThis.aceCursor; if (!layer) return false; await layer.settled(); return true; })()";

export const cursorTeardownExpression =
  "(() => { globalThis.aceCursor?.teardown(); globalThis.aceCursor = undefined; return true; })()";

/** Evaluates to the layer's host element (as a remote object), for snapshot exclusion. */
export const cursorHostExpression = "globalThis.aceCursor?.host() ?? null";
