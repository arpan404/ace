import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { checkoutError } from "./checkout-source.ts";
import { fileManagement, type TrashEntry } from "./file-management-source.ts";
import { formatBytes } from "./use-file-actions.ts";

export function TrashDialog(props: {
  threadId: string;
  onClose(): void;
  onChanged(path: string): void;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const [after, setAfter] = useState<string>();
  const [previous, setPrevious] = useState<TrashEntry[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const manager = fileManagement(client, props.threadId);
  const page = useDaemonQuery({
    queryKey: ["checkout", "trash", props.threadId, after],
    retry: false,
    read: (_client, signal) => manager.trash(after, signal),
  });
  const entries = [...previous, ...(page.data?.entries ?? [])];
  const restore = async (entry: TrashEntry) => {
    setBusy(entry.id);
    setError(undefined);
    try {
      await manager.mutate({ op: "restore", trashId: entry.id, path: entry.path, expected: null });
      setPrevious((list) => list.filter((item) => item.id !== entry.id));
      await queries.invalidateQueries({ queryKey: ["checkout"] });
      props.onChanged(entry.path);
    } catch (failure) {
      setError(checkoutError(failure).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Recently deleted</DialogTitle>
          <DialogDescription>
            Restore files before their recovery period ends. Existing files won't be replaced.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {(error || page.error) && (
            <p role="alert" className="text-ui text-status-failed">
              {error ?? checkoutError(page.error).message}
            </p>
          )}
          {page.error && (
            <Button variant="ghost" onClick={() => void page.refetch()}>
              Try again
            </Button>
          )}
          {page.isPending ? (
            <p role="status">Loading deleted files…</p>
          ) : (
            !entries.length && <p className="text-muted-foreground">No recently deleted files.</p>
          )}
          <ul aria-label="Deleted files">
            {entries.map((entry) => (
              <li key={entry.id} className="flex h-9 min-w-0 items-center gap-2 text-ui">
                <span title={entry.path} className="min-w-0 flex-1 truncate">
                  {entry.path}
                </span>
                <span className="shrink-0 text-xs text-subtle-foreground">
                  {formatBytes(entry.size)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== undefined}
                  onClick={() => void restore(entry)}
                >
                  {busy === entry.id ? "Restoring…" : "Restore"}
                </Button>
              </li>
            ))}
          </ul>
          {page.data?.nextCursor && (
            <Button
              variant="ghost"
              disabled={page.isFetching}
              onClick={() => {
                setPrevious(entries);
                setAfter(page.data?.nextCursor ?? undefined);
              }}
            >
              Show older
            </Button>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
