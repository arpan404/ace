/** How a fetched file is handed to this device. */
export type SaveWay = "share" | "download";

/** What a file is, as the downloads list knows it. */
export interface SavedFile {
  filename: string;
  mimeType: string;
  flags: readonly ("executable" | "archive")[];
}

/**
 * Phones share the file, so the share sheet can put it in Files or another app; everything else
 * saves it as the browser's own download. A phone that can't share files downloads it too.
 */
export function saveWay(device: { touch: boolean; shareFiles: boolean }): SaveWay {
  return device.touch && device.shareFiles ? "share" : "download";
}

/** The type the file is saved as: an executable is never handed over as something to run. */
export function savedType(file: SavedFile): string {
  if (file.flags.includes("executable")) return "application/octet-stream";
  return file.mimeType || "application/octet-stream";
}

/** Hands a file fetched from the daemon to this device's save or share sheet. */
export async function saveToDevice(bytes: Uint8Array<ArrayBuffer>, file: SavedFile): Promise<void> {
  const type = savedType(file);
  const shared = new File([bytes], file.filename, { type });
  const way = saveWay({
    touch: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    shareFiles: navigator.canShare?.({ files: [shared] }) ?? false,
  });
  if (way === "share") {
    try {
      await navigator.share({ files: [shared], title: file.filename });
      return;
    } catch (error) {
      // The person closed the sheet: nothing more to do.
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(shared);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = file.filename;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // The download has its own copy once started; the next task is late enough to let go.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
