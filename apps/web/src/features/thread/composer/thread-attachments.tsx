import type { Attachment } from "@ace/protocol";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatBytes } from "@/components/attachment-format.ts";
import { useThreadSources, type ThreadRef } from "../sources/index.ts";
export function ThreadAttachments(props: { thread: ThreadRef; onClose(): void }) {
  const sources = useThreadSources();
  const files = useQuery({
    queryKey: ["thread", "attachments", props.thread.id],
    queryFn: ({ signal }) => sources.context.list(props.thread, signal),
  });
  const [removing, setRemoving] = useState<string>();
  const [error, setError] = useState<string>();
  const remove = async (file: Attachment) => {
    setRemoving(file.sha256);
    setError(undefined);
    try {
      await sources.context.release(props.thread, file.sha256);
      await files.refetch();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Couldn't remove this file. Try again.",
      );
    } finally {
      setRemoving(undefined);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attachments</DialogTitle>
          <DialogDescription>
            Files stored for this thread. Removing a file frees space and stops it opening from
            older messages.
          </DialogDescription>
        </DialogHeader>
        {files.isPending ? (
          <Spinner label="Loading attachments" />
        ) : files.isError ? (
          <p role="alert">
            Couldn't load the files.{" "}
            <Button variant="ghost" size="sm" onClick={() => void files.refetch()}>
              Try again
            </Button>
          </p>
        ) : !files.data.length ? (
          <p className="text-ui text-muted-foreground">No attachments in this thread.</p>
        ) : (
          <ul className="max-h-80 overflow-auto">
            {files.data.map((file) => (
              <li key={file.sha256} className="flex h-9 items-center gap-2 text-ui">
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="text-xs text-subtle-foreground">{formatBytes(file.bytes)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${file.name}`}
                  disabled={!!removing}
                  onClick={() => void remove(file)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-ui text-status-failed">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
