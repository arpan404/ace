import type { PictureImage } from "./picture-renderer.ts";

/** A JPEG's bytes as something a canvas draws, freed once drawn. */
export async function jpegImage(bytes: Uint8Array): Promise<PictureImage> {
  const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: "image/jpeg" }));
  return {
    draw: (target, width, height) => target.drawImage(bitmap, 0, 0, width, height),
    close: () => bitmap.close(),
  };
}

/**
 * Draws a picture upright on its canvas: `rotation` is the turn (degrees clockwise) that shows
 * it upright, so a landscape picture of a portrait screen turns. The canvas takes the upright
 * size; returns it.
 */
export function drawUpright(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  image: PictureImage,
  picture: { width: number; height: number; rotation: number },
): { width: number; height: number } {
  const turned = picture.rotation % 180 !== 0;
  const width = turned ? picture.height : picture.width;
  const height = turned ? picture.width : picture.height;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate((picture.rotation * Math.PI) / 180);
  context.translate(-picture.width / 2, -picture.height / 2);
  image.draw(context, picture.width, picture.height);
  context.restore();
  return { width, height };
}
