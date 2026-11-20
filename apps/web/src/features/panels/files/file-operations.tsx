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
import type { FileMutation } from "./file-management-source.ts";
import { cleanPath, parentPath, type FileOperationDialog } from "./file-operation.ts";
import { ArchiveDialog } from "./folder-download.tsx";
import { TrashDialog } from "./recently-deleted.tsx";
import { useFileMutations } from "./use-file-mutations.ts";

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
  const { operation: op } = props;
  const original = "path" in op ? cleanPath(op.path) : "";
  const many = op.kind === "delete" && op.paths && op.paths.length > 1 ? op.paths : undefined;
  const [value, setValue] = useState("folder" in op ? op.folder : original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mutations = useFileMutations(props.threadId, (path) => props.onChanged(path));
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
      if (op.kind === "delete") {
        await mutations.remove(many ?? [original]);
        props.onClose();
        return;
      }
      let mutation: FileMutation;
      if (op.kind === "create" || op.kind === "mkdir") {
        mutation =
          op.kind === "create"
            ? { op: "create", path, expected: null, text: "" }
            : { op: "mkdir", path, expected: null };
      } else {
        if (op.kind === "rename" && parentPath(path) !== parentPath(original))
          throw new Error("Keep the same folder when renaming. Use Move to change folders.");
        mutation = {
          op: op.kind,
          path: original,
          expected: await mutations.versionOf(original),
          destination: path,
          destinationExpected: null,
        };
      }
      const result = await mutations.run(mutation);
      props.onChanged(result.path, result.destination);
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
              ? `Move ${many ? `${many.length} items` : original} to Recently deleted? You can restore ${many ? "them" : "it"} from Recently deleted.`
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
