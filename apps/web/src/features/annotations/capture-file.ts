import type { BrowserAnnotationCapture } from "@ace/protocol";

/** A capture's bytes as a file to upload, named for the image list the agent reads. */
export function captureFile(capture: BrowserAnnotationCapture, name: string): File {
  const binary = atob(capture.data);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  const extension = capture.mimeType === "image/png" ? "png" : "jpg";
  return new File([bytes], `${name}.${extension}`, { type: capture.mimeType });
}
