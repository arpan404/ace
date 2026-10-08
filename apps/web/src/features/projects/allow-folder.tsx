import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ClientApi } from "@ace/client";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.tsx";
import { addProjectRoot } from "@/lib/project-roots.ts";

export function AllowFolder(props: {
  client: ClientApi | undefined;
  path: string;
  onAllowed(): void;
}) {
  const query = useQueryClient();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState(false);
  const [open, setOpen] = useState(false);
  const allow = () => {
    if (!props.client) return;
    setPending(true);
    setProblem(false);
    void addProjectRoot(props.client, props.path)
      .then(async () => {
        await query.invalidateQueries({ queryKey: ["projects", "folders"] });
        setOpen(false);
        props.onAllowed();
      })
      .catch(() => setProblem(true))
      .finally(() => setPending(false));
  };
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={!props.client || pending}
        onClick={() => {
          setProblem(false);
          setOpen(true);
        }}
      >
        Allow this folder…
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Allow this folder?</DialogTitle>
            <DialogDescription>
              ace will be able to open projects in this folder and its subfolders. You can remove it
              in Settings under Project folders.
            </DialogDescription>
          </DialogHeader>
          <p className="break-all text-ui">{props.path}</p>
          {problem && (
            <p role="alert" className="text-sm text-status-failed">
              Couldn't allow this folder. Check that it exists and is accessible, then try again.
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!props.client || pending} onClick={allow}>
              {pending ? "Allowing…" : "Allow folder"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
