import type { BrowserAnnotationConfig, BrowserAnnotationPageCommand } from "@ace/protocol";
import type { OverlayInit } from "./init.ts";
import { overlayBundle } from "./overlay-bundle.gen.ts";
import { overlayPalettes, overlayTokens } from "./palette.ts";

/**
 * The annotate overlay as CDP expressions (ADR 0082). Every expression runs in the isolated
 * world named `annotationWorldName`, where `annotationBindingName` is the overlay's only way
 * out. The page's own scripts can see neither.
 */
export const annotationWorldName = "ace-annotate";
export const annotationBindingName = "__aceAnnotateEmit";

/** Bundle plus install: evaluates to the new overlay's document id. */
export function annotationInstallExpression(config: Partial<BrowserAnnotationConfig>): string {
  const init: OverlayInit = {
    binding: annotationBindingName,
    palettes: overlayPalettes(),
    tokens: overlayTokens(),
    config,
  };
  return `${overlayBundle}\n;globalThis.aceAnnotateInstall(${JSON.stringify(init)});`;
}

/** Evaluates to whether an overlay received the command. */
export function annotationCommandExpression(command: BrowserAnnotationPageCommand): string {
  return `(() => { const overlay = globalThis.aceAnnotate; if (!overlay) return false; overlay.command(${JSON.stringify(command)}); return true; })()`;
}

export const annotationTeardownExpression =
  "(() => { globalThis.aceAnnotate?.teardown(); globalThis.aceAnnotate = undefined; return true; })()";

/** A promise: hides the bar, editor and outline, then waits two frames. */
export const annotationPrepareCaptureExpression =
  "(async () => { const overlay = globalThis.aceAnnotate; if (!overlay) return false; await overlay.prepareCapture(); return true; })()";

export const annotationFinishCaptureExpression =
  "(() => { globalThis.aceAnnotate?.finishCapture(); return true; })()";

/** Evaluates to the annotated element's viewport box, or null when it is gone. */
export function annotationRectExpression(id: string): string {
  return `globalThis.aceAnnotate?.rect(${JSON.stringify(id)}) ?? null`;
}

/** Evaluates to the visual viewport's offset, size and device pixel ratio. */
export const annotationViewportExpression = "globalThis.aceAnnotate?.viewport() ?? null";

/** Evaluates to the overlay's host element (as a remote object), for snapshot exclusion. */
export const annotationHostExpression = "globalThis.aceAnnotate?.host() ?? null";

export {
  cursorApplyExpression,
  cursorHostExpression,
  cursorInstallExpression,
  cursorSettledExpression,
  cursorTeardownExpression,
  cursorWorldName,
  defaultCursorStyle,
  maskedSecretValue,
  secretFieldSelector,
  type CursorOp,
  type CursorPoint,
  type CursorRect,
  type CursorStyle,
} from "./cursor.ts";
