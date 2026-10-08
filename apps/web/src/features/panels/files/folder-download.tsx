import { useClient } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { DownloadError, saveDownload } from "@/lib/save-download.ts";
import { checkoutError } from "./checkout-source.ts";
import { fileManagement } from "./file-management-source.ts";
import { formatBytes } from "./use-file-actions.ts";

export function ArchiveDialog(props: { threadId: string; path: string; onClose(): void }) {
  const client = useClient();
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancel = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => cancel.current?.abort(), []);
  const preview = useDaemonQuery({
    queryKey: ["checkout", "archive", props.threadId, props.path, includeIgnored],
    retry: false,
    gcTime: 0,
    read: (_client, signal) =>
      fileManagement(client, props.threadId).preview(props.path, includeIgnored, signal),
  });
  const download = async () => {
    if (!preview.data || busy) return;
    const controller = new AbortController();
    cancel.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      await saveDownload(
        `${props.path.split("/").at(-1) || "checkout"}.tar.gz`,
        client.downloadFile(
          {
            threadId: ThreadId.parse(props.threadId),
            op: "archive.download",
            previewId: preview.data.previewId,
          },
          { signal: controller.signal },
        ),
        controller.signal,
      );
      props.onClose();
    } catch (failure) {
      const issue = checkoutError(failure);
      if (!controller.signal.aborted && issue.code !== "aborted")
        setError(
          failure instanceof DownloadError
            ? failure.message
            : issue.code === "EXPIRED" || issue.code === "CONFLICT"
              ? "The folder changed or this preview expired. Close this window and choose Download folder again."
              : issue.message,
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          cancel.current?.abort();
          props.onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Download folder</DialogTitle>
          <DialogDescription>{props.path || "Checkout"} · tar.gz archive</DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-ui">
          <Checkbox checked={includeIgnored} disabled={busy} onCheckedChange={setIncludeIgnored} />
          Include ignored files
        </label>
        <p role="status" className="text-ui text-muted-foreground">
          {preview.data && !preview.isFetching
            ? `${preview.data.entries} entries · ${formatBytes(preview.data.bytes)} before compression`
            : "Counting files…"}
        </p>
        {(error || preview.error) && (
          <p role="alert" className="text-ui text-status-failed">
            {error ?? checkoutError(preview.error).message}
          </p>
        )}
        {preview.error && (
          <Button variant="ghost" onClick={() => void preview.refetch()}>
            Try again
          </Button>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              cancel.current?.abort();
              props.onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || preview.isFetching || !preview.data || !!preview.error}
            onClick={() => void download()}
          >
            {busy ? "Downloading…" : "Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
