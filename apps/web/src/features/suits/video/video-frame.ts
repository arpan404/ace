/*
 * The part of a video frame that shows in its box under `object-fit` (ADR 0169), so the palette
 * and the live check read the picture the person sees, not the parts a `cover` crop cuts off.
 * Pure, plus one reader over a canvas at the edge.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ShownFrame {
  /** The source rectangle, in the video's own pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Where that rectangle lands on the page. */
  box: Box;
}

export function shownFrame(
  video: { width: number; height: number },
  box: Box,
  fit: "cover" | "contain",
): ShownFrame | undefined {
  if (video.width <= 0 || video.height <= 0 || box.width <= 0 || box.height <= 0) return undefined;
  if (fit === "cover") {
    const scale = Math.max(box.width / video.width, box.height / video.height);
    const sw = box.width / scale;
    const sh = box.height / scale;
    return { sx: (video.width - sw) / 2, sy: (video.height - sh) / 2, sw, sh, box };
  }
  const scale = Math.min(box.width / video.width, box.height / video.height);
  const width = video.width * scale;
  const height = video.height * scale;
  return {
    sx: 0,
    sy: 0,
    sw: video.width,
    sh: video.height,
    box: {
      left: box.left + (box.width - width) / 2,
      top: box.top + (box.height - height) / 2,
      width,
      height,
    },
  };
}

/** The canvas the reads draw into, kept per size so a read allocates nothing new. */
const canvases = new Map<string, CanvasRenderingContext2D | null>();

/** A picture's own size, once there is one to draw: a decoded video frame or a loaded image. */
function pictureSize(source: HTMLVideoElement | HTMLImageElement) {
  if (source instanceof HTMLImageElement)
    return source.complete
      ? { width: source.naturalWidth, height: source.naturalHeight }
      : undefined;
  // HAVE_CURRENT_DATA: a frame is there to draw.
  return source.readyState >= 2
    ? { width: source.videoWidth, height: source.videoHeight }
    : undefined;
}

/**
 * The video's shown frame (or the still image in its place) averaged to `columns × rows` RGBA,
 * with where it lands; undefined before there is a picture. Throws a `SecurityError` when it
 * can't be read (no CORS).
 */
export function readVideoFrame(
  video: HTMLVideoElement | HTMLImageElement,
  columns: number,
  rows: number,
  fit: "cover" | "contain",
): { pixels: Uint8ClampedArray; box: Box } | undefined {
  const size = pictureSize(video);
  if (!size) return undefined;
  const rect = video.getBoundingClientRect();
  const shown = shownFrame(
    size,
    { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    fit,
  );
  if (!shown) return undefined;
  const key = `${columns}x${rows}`;
  let context = canvases.get(key);
  if (context === undefined) {
    const canvas = video.ownerDocument.createElement("canvas");
    canvas.width = columns;
    canvas.height = rows;
    context = canvas.getContext("2d", { willReadFrequently: true });
    canvases.set(key, context);
  }
  if (!context) return undefined;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(video, shown.sx, shown.sy, shown.sw, shown.sh, 0, 0, columns, rows);
  return { pixels: context.getImageData(0, 0, columns, rows).data, box: shown.box };
}
