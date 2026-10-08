import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { checkoutError } from "./checkout-source.ts";
import { useCheckoutSource } from "./use-checkout.ts";
import { fileManagement, type FileMutation } from "./file-management-source.ts";
import { cleanPath, parentPath, type FileOperationDialog } from "./file-operation.ts";
import { ArchiveDialog } from "./folder-download.tsx";
import { TrashDialog } from "./recently-deleted.tsx";

const titles = {
  create: "New file",
  mkdir: "New folder",
  rename: "Rename",
  move: "Move",
  delete: "Delete",
};

export function FileOperations(props: {
  threadId: string;
  operation: FileOperationDialog;
  onClose(): void;
  onChanged(path: string, destination?: string): void;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const source = useCheckoutSource();
  const toast = useToast();
  const { operation: op } = props;
  const original = "path" in op ? cleanPath(op.path) : "";
  const [value, setValue] = useState("folder" in op ? op.folder : original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const manager = fileManagement(client, props.threadId);
  const refresh = () => void queries.invalidateQueries({ queryKey: ["checkout"] });
  if (op.kind === "archive")
    return <ArchiveDialog threadId={props.threadId} path={original} onClose={props.onClose} />;
  if (op.kind === "trash")
    return (
      <TrashDialog threadId={props.threadId} onClose={props.onClose} onChanged={props.onChanged} />
    );
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const path = value.trim();
      let mutation: FileMutation;
      if (op.kind === "create" || op.kind === "mkdir") {
        mutation =
          op.kind === "create"
            ? { op: "create", path, expected: null, text: "" }
            : { op: "mkdir", path, expected: null };
      } else {
        const expected = (await source.stat(props.threadId, original)).version;
        if (expected === null) throw new Error("This path is gone. Refresh and try again.");
        mutation =
          op.kind === "delete"
            ? { op: "delete", path: original, expected }
            : {
                op: op.kind,
                path: original,
                expected,
                destination: path,
                destinationExpected: null,
              };
        if (op.kind === "rename" && parentPath(path) !== parentPath(original))
          throw new Error("Keep the same folder when renaming. Use Move to change folders.");
      }
      const result = await manager.mutate(mutation);
      refresh();
      props.onChanged(result.path, result.destination);
      if (result.trashId) {
        const trashId = result.trashId;
        toast.add({
          title: `Deleted ${original}`,
          actionProps: {
            children: "Undo",
            onClick: () => {
              void manager.mutate({ op: "restore", trashId, path: original, expected: null }).then(
                () => {
                  refresh();
                  props.onChanged(original);
                  toast.add({ title: `Restored ${original}` });
                },
                (failure: unknown) =>
                  toast.error({
                    title: "Couldn't restore the file",
                    description: checkoutError(failure).message,
                  }),
              );
            },
          },
        });
      }
      props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't change the file. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titles[op.kind]}</DialogTitle>
          <DialogDescription>
            {op.kind === "delete"
              ? `Move ${original} to Recently deleted? You can restore it from Recently deleted.`
              : "Use a path relative to this checkout."}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {op.kind !== "delete" && (
            <Input
              aria-label={op.kind === "move" ? "Destination path" : "Path"}
              value={value}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          {error && (
            <p role="alert" className="py-2 text-ui text-status-failed">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={op.kind === "delete" ? "danger" : "secondary"}
              disabled={busy || (op.kind !== "delete" && !value.trim())}
            >
              {busy ? "Working…" : titles[op.kind]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
