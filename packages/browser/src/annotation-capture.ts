import { z } from "zod";
import {
  annotationFinishCaptureExpression,
  annotationPrepareCaptureExpression,
  annotationRectExpression,
  annotationViewportExpression,
} from "@ace/browser-annotate";
import {
  browserAnnotationCaptureLimit,
  type BrowserAnnotationCapture,
  type BrowserAnnotationCaptureTarget,
} from "@ace/protocol";
import { BrowserActionError } from "./action-error.ts";
import type { BrowserCdp } from "./backend.ts";
import { evaluateInWorld } from "./annotation-install.ts";
import { imageSize } from "./image-size.ts";

const Viewport = z.object({
  pageX: z.number().finite(),
  pageY: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  devicePixelRatio: z.number().finite().positive(),
});
const Rect = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite(),
  })
  .nullable();
const Shot = z.object({ data: z.string() });
/** Page images keep their long edge readable without approaching the relay's frame bound. */
const pageLongEdge = 1920;
const cropLongEdge = 1024;
const cropPadding = 8;

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}
type Format = { format: "png" } | { format: "jpeg"; quality: number };

async function shoot(
  cdp: BrowserCdp,
  clip: Clip,
  formats: Format[],
): Promise<BrowserAnnotationCapture> {
  for (const format of formats) {
    const { data } = Shot.parse(
      await cdp.send("Page.captureScreenshot", { ...format, clip, captureBeyondViewport: false }),
    );
    if (data.length > browserAnnotationCaptureLimit) continue;
    const size = imageSize(Buffer.from(data, "base64"));
    if (!size) throw new Error("The browser returned an unreadable image");
    return { mimeType: format.format === "png" ? "image/png" : "image/jpeg", data, ...size };
  }
  throw new BrowserActionError("limit");
}

function scaleFor(width: number, height: number, ratio: number, longEdge: number): number {
  return Math.min(1, longEdge / (Math.max(width, height) * ratio));
}

/**
 * Screenshot for an annotation message: the bar, editor and outline are hidden for two frames
 * while markers stay, so the agent sees the numbers the person placed.
 */
export async function captureAnnotation(
  cdp: BrowserCdp,
  contextId: number,
  target: BrowserAnnotationCaptureTarget,
): Promise<BrowserAnnotationCapture> {
  const viewport = Viewport.parse(
    (await evaluateInWorld(cdp, contextId, annotationViewportExpression)).value,
  );
  let clip: Clip;
  let formats: Format[];
  if (target.kind === "page") {
    clip = {
      x: viewport.pageX,
      y: viewport.pageY,
      width: viewport.width,
      height: viewport.height,
      scale: scaleFor(viewport.width, viewport.height, viewport.devicePixelRatio, pageLongEdge),
    };
    formats = [
      { format: "jpeg", quality: 80 },
      { format: "jpeg", quality: 60 },
    ];
  } else {
    const rect = Rect.parse(
      (await evaluateInWorld(cdp, contextId, annotationRectExpression(target.id))).value,
    );
    if (!rect) throw new BrowserActionError("element_unavailable");
    const left = Math.max(0, rect.x - cropPadding);
    const top = Math.max(0, rect.y - cropPadding);
    const right = Math.min(viewport.width, rect.x + rect.width + cropPadding);
    const bottom = Math.min(viewport.height, rect.y + rect.height + cropPadding);
    if (right - left < 1 || bottom - top < 1) throw new BrowserActionError("not_visible");
    const width = right - left;
    const height = bottom - top;
    clip = {
      x: viewport.pageX + left,
      y: viewport.pageY + top,
      width,
      height,
      scale: scaleFor(width, height, viewport.devicePixelRatio, cropLongEdge),
    };
    formats = [{ format: "png" }, { format: "jpeg", quality: 85 }, { format: "jpeg", quality: 60 }];
  }
  await evaluateInWorld(cdp, contextId, annotationPrepareCaptureExpression, { awaitPromise: true });
  try {
    return await shoot(cdp, clip, formats);
  } finally {
    await evaluateInWorld(cdp, contextId, annotationFinishCaptureExpression).catch(() => {});
  }
}
