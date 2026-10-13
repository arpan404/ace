import {
  projectImageMaxBytes,
  projectImageSize,
  projectImageTypes,
  sniffProjectImage,
} from "@ace/project-picker";
import { ProjectIcon } from "@ace/protocol";

/** A picked image made into a project badge, or why it can't be one. */
export type ProjectImageRead = { ok: true; icon: string } | { ok: false; problem: string };

const wrongType = "Use a PNG, JPEG, WebP or GIF image.";

/** The centred square of a `width` × `height` image. */
export function centredSquare(width: number, height: number) {
  const side = Math.min(width, height);
  return { x: (width - side) / 2, y: (height - side) / 2, side };
}

/**
 * Check a picked file (type, size cap, and that its bytes are the image it claims), then crop
 * its centred square and scale it to the badge size. The result is a small data URL the daemon
 * stores in its own data; the file's path is never kept.
 */
export async function readProjectImage(file: File): Promise<ProjectImageRead> {
  if (!projectImageTypes.some((type) => type === file.type))
    return { ok: false, problem: wrongType };
  if (file.size > projectImageMaxBytes)
    return { ok: false, problem: "That image is over 5 MB. Pick a smaller one." };
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (sniffProjectImage(head) !== file.type)
    return { ok: false, problem: "That file isn't a PNG, JPEG, WebP or GIF image." };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, problem: "ace couldn't read that image. Try another file." };
  }
  try {
    const crop = centredSquare(bitmap.width, bitmap.height);
    if (crop.side < 1) return { ok: false, problem: "That image is empty." };
    const canvas = document.createElement("canvas");
    canvas.width = projectImageSize;
    canvas.height = projectImageSize;
    const context = canvas.getContext("2d");
    if (!context) return { ok: false, problem: "ace couldn't read that image. Try another file." };
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.side,
      crop.side,
      0,
      0,
      projectImageSize,
      projectImageSize,
    );
    const png = canvas.toDataURL("image/png");
    const icon = ProjectIcon.safeParse(png).success ? png : canvas.toDataURL("image/webp", 0.9);
    return ProjectIcon.safeParse(icon).success
      ? { ok: true, icon }
      : { ok: false, problem: "That image is too detailed to use. Try a simpler one." };
  } finally {
    bitmap.close();
  }
}
