import { z } from "zod";
import { Attachment } from "./context.ts";

/** The image types an agent may post; the daemon checks the bytes, never the name or claim. */
export const SharedImageType = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export type SharedImageType = z.infer<typeof SharedImageType>;
/** Largest image file an agent may post by path, in bytes. */
export const maxSharedImageBytes = 128 * 1024 * 1024;
/** Largest image an agent may post as base64 `data`, in decoded bytes. */
export const maxSharedImageDataBytes = 16 * 1024 * 1024;
/** Base64 characters for `maxSharedImageDataBytes`, padding included. */
export const maxSharedImageDataChars = Math.ceil(maxSharedImageDataBytes / 3) * 4;
export const SharedImageAlt = z.string().min(1).max(300).regex(/\S/);
export const SharedImageCaption = z.string().max(500);
/** Exactly one of `path` or `data`; the tool reports which one is missing or doubled. */
export const ImageShowInput = z.strictObject({
  path: z.string().min(1).max(4096).optional(),
  data: z
    .string()
    .min(1)
    .max(maxSharedImageDataChars)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .optional(),
  mimeType: SharedImageType.optional(),
  alt: SharedImageAlt,
  caption: SharedImageCaption.optional(),
});
export type ImageShowInput = z.infer<typeof ImageShowInput>;
/** An image an agent posted into its reply. Its bytes live in the thread's attachment store. */
export const SharedImage = z.object({
  attachment: Attachment,
  alt: z.string().min(1).max(300),
  caption: SharedImageCaption.optional(),
});
export type SharedImage = z.infer<typeof SharedImage>;
