import { useState } from "react";
import { fetchBrowserDownload } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useToast } from "@/components/ui/toast.tsx";
import type { BrowserDownloadView } from "../sources.ts";
import { saveToDevice } from "./save-to-device.ts";
import { reason } from "./use-browser-features.ts";

/**
 * "Save to this device" for a thread's finished downloads: the file comes over this connection
 * in chunks (resuming after a reconnect), then goes to the device's save or share sheet.
 * `saving` holds each running transfer's progress, 0 to 1.
 */
export function useSaveDownload(threadId: string) {
  const client = useClient();
  const toast = useToast();
  const [saving, setSaving] = useState<ReadonlyMap<string, number>>(new Map());
  const progress = (downloadId: string, fraction: number | undefined) =>
    setSaving((current) => {
      const next = new Map(current);
      if (fraction === undefined) next.delete(downloadId);
      else next.set(downloadId, fraction);
      return next;
    });
  const save = async (download: BrowserDownloadView) => {
    if (saving.has(download.downloadId)) return;
    progress(download.downloadId, 0);
    try {
      const bytes = await fetchBrowserDownload(client, threadId, download.downloadId, {
        onProgress: (received, size) => progress(download.downloadId, size ? received / size : 1),
      });
      await saveToDevice(new Uint8Array(bytes), download);
    } catch (error) {
      toast.error({ title: `Couldn't save ${download.filename}`, description: reason(error) });
    } finally {
      progress(download.downloadId, undefined);
    }
  };
  return { saving, save };
}
