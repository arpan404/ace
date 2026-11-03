import { useClient } from "@ace/client-react";
import { useCallback, useState } from "react";
import { DownloadError, saveDownload } from "@/lib/save-download.ts";
import { linkedFileChunks, readWhole, tooLargeToLoad } from "./attachment-content.ts";
import type { PreviewFile } from "./attachment-format.ts";
import { useToast } from "./ui/toast.tsx";

/*
 * Download for a shown file. A file a message links is streamed to where the person saves it,
 * at any size; a sent or saved one is read whole within the preview budget, then saved.
 */

export function useSaveFile(file: PreviewFile): {
  save(): void;
  busy: boolean;
  /** This device can't save it: no bytes here, or over the budget. */
  off: boolean;
} {
  const client = useClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const source = file.source;
  const off = !source || tooLargeToLoad(source);
  const save = useCallback(() => {
    if (!source || tooLargeToLoad(source)) return;
    setBusy(true);
    const saved =
      source.kind === "link"
        ? saveDownload(file.name, linkedFileChunks(client, source))
        : readWhole(client, source, undefined, new AbortController().signal).then((blob) => {
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = file.name;
            link.click();
            // The download holds the bytes once it starts; the URL can go after that.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          });
    saved
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        toast.error({
          title: `Couldn't download ${file.name}`,
          ...(error instanceof DownloadError ? { description: error.message } : {}),
        });
      })
      .finally(() => setBusy(false));
  }, [client, file.name, source, toast]);
  return { save, busy, off };
}
