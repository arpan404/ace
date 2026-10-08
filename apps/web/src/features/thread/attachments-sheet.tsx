import { TrashIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useThreadSources, type ThreadRef } from "./sources/index.ts";
import { formatBytes } from "@/components/format-bytes.ts";

export function AttachmentsSheet(props: { thread: ThreadRef; onClose(): void }) {
  const sources = useThreadSources();
  const queries = useQueryClient();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const files = useDaemonQuery({
    queryKey: ["thread-attachments", props.thread.id],
    retry: false,
    gcTime: 0,
    staleTime: 0,
    read: (_client, signal) => sources.context.list(props.thread, signal),
  });
  const remove = async (hash: string) => {
    setBusy(hash);
    setError(undefined);
    try {
      await sources.context.release(props.thread, hash);
      await queries.invalidateQueries({ queryKey: ["thread-attachments", props.thread.id] });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't remove the attachment. Check the connection and try again.",
      );
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Sheet open onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Attachments</SheetTitle>
          <SheetDescription>
            Files kept in this thread. Removing one frees space and makes it unavailable in earlier
            messages.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {(error || files.error) && (
            <p role="alert" className="text-ui text-status-failed">
              {error ?? "Couldn't load attachments. Check the connection and try again."}
            </p>
          )}
          {files.error && (
            <Button variant="ghost" onClick={() => void files.refetch()}>
              Try again
            </Button>
          )}
          {files.isPending ? (
            <p role="status">Loading attachments…</p>
          ) : (
            <p className="py-2 text-xs text-subtle-foreground">
              {files.data?.length ?? 0} of 256 attachments
            </p>
          )}
          {files.data?.length === 0 && (
            <p className="text-ui text-muted-foreground">No attachments in this thread.</p>
          )}
          <ul aria-label="Thread attachments">
            {files.data?.map((file) => (
              <li key={file.sha256} className="flex h-9 min-w-0 items-center gap-2 text-ui">
                <span className="min-w-0 flex-1 truncate" title={file.name}>
                  {file.name}
                </span>
                <span className="text-xs text-subtle-foreground">{formatBytes(file.bytes)}</span>
                <IconButton
                  icon={TrashIcon}
                  label={`Remove ${file.name}`}
                  className="size-7"
                  disabled={busy !== undefined}
                  onClick={() => void remove(file.sha256)}
                />
              </li>
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}
