/*
 * Raster images through Bun's built-in pipeline (`Bun.Image`): read a JPEG, PNG, WebP or GIF,
 * fit it in a box and encode it as JPEG or PNG. The work runs off the JavaScript thread. The
 * daemon runs on Bun and has no other decoder for these; anything that needs SVG, raw pixels or
 * compositing stays on sharp, which Bun's pipeline does not offer.
 */

/** Where the image comes from: bytes, or a file ace itself wrote (never a path from outside). */
export type ImageInput = Uint8Array | { path: string };

export interface ImageSource {
  input: ImageInput;
  /** Images with more pixels than this are refused before their pixels are decoded. */
  maxPixels: number;
  /** Turn a JPEG upright from its EXIF orientation before anything else. */
  autoOrient: boolean;
}

export type ImageEncoding = { format: "jpeg"; quality: number } | { format: "png" };

export interface EncodedImage {
  bytes: Buffer;
  width: number;
  height: number;
}

interface Pipeline {
  readonly width: number;
  readonly height: number;
  resize(
    width: number,
    height: number,
    options: { fit: "inside"; withoutEnlargement: boolean },
  ): Pipeline;
  jpeg(options: { quality: number }): Pipeline;
  png(): Pipeline;
  metadata(): Promise<{ width: number; height: number }>;
  buffer(): Promise<Buffer>;
}
type PipelineConstructor = new (
  input: Uint8Array | string,
  options: { maxPixels: number; autoOrient: boolean },
) => Pipeline;

function isPipelineConstructor(value: unknown): value is PipelineConstructor {
  if (typeof value !== "function") return false;
  const prototype: unknown = Reflect.get(value, "prototype");
  return (
    typeof prototype === "object" &&
    prototype !== null &&
    ["resize", "jpeg", "png", "metadata", "buffer"].every(
      (name) => typeof Reflect.get(prototype, name) === "function",
    )
  );
}

function pipeline(source: ImageSource): Pipeline {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  const Image: unknown =
    typeof bun === "object" && bun !== null ? Reflect.get(bun, "Image") : undefined;
  if (!isPipelineConstructor(Image)) throw new Error("Image decoding needs the Bun runtime");
  const input = source.input instanceof Uint8Array ? source.input : source.input.path;
  return new Image(input, { maxPixels: source.maxPixels, autoOrient: source.autoOrient });
}

/** The image's stored size, read from its header without decoding its pixels. */
export async function imageSize(source: ImageSource): Promise<{ width: number; height: number }> {
  const { width, height } = await pipeline(source).metadata();
  return { width, height };
}

/**
 * The image scaled down, keeping its shape, to fit `box` (never scaled up), then encoded.
 * Rejects when the input is not an image the pipeline can decode or has too many pixels.
 */
export async function fitImage(
  source: ImageSource,
  box: { width: number; height: number },
  encoding: ImageEncoding,
): Promise<EncodedImage> {
  const fitted = pipeline(source).resize(box.width, box.height, {
    fit: "inside",
    withoutEnlargement: true,
  });
  const encoded =
    encoding.format === "jpeg" ? fitted.jpeg({ quality: encoding.quality }) : fitted.png();
  const bytes = await encoded.buffer();
  // After the terminal, the pipeline reports the output's size.
  return { bytes, width: encoded.width, height: encoded.height };
}
