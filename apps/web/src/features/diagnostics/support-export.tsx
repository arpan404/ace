import { useClient, useConnectionState } from "@ace/client-react";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
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

const Artifact = z.object({ artifactId: z.string().min(1).max(128) });

export function SupportExport() {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const checkbox = useId();
  const [open, setOpen] = useState(false);
  const [include, setInclude] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const close = () => {
    abort.current?.abort();
    setOpen(false);
  };
  const run = async () => {
    setRunning(true);
    setError(undefined);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const result = await client.request(
        {
          type: "files.request",
          scope: "support",
          operation: { op: "artifact.support", includeThreads: include },
        },
        { signal: controller.signal, timeoutMs: 60_000 },
      );
      if (result.type !== "files.result") throw new Error();
      const { artifactId } = Artifact.parse(result.value);
      const parts: ArrayBuffer[] = [];
      let bytes = 0;
      for await (const chunk of client.downloadFile(
        { scope: "support", op: "artifact.download", artifactId, offset: 0 },
        { signal: controller.signal },
      )) {
        bytes += chunk.length;
        if (bytes > 16 * 1024 ** 2) throw new Error();
        parts.push(new Uint8Array(chunk).buffer);
      }
      const url = URL.createObjectURL(new Blob(parts, { type: "application/gzip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "ace-support.tar.gz";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setOpen(false);
    } catch {
      if (!controller.signal.aborted)
        setError(
          include
            ? "Couldn't export conversations. Use ace on this computer, or uncheck Include conversations and try again."
            : "Couldn't export the support bundle. Reconnect to this computer and try again.",
        );
    } finally {
      setRunning(false);
    }
  };
  return (
    <>
      <div className="flex h-9 items-center justify-between gap-3 text-ui">
        <span>Support bundle</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={!ready || running}
          onClick={() => {
            setError(undefined);
            setOpen(true);
          }}
        >
          Export
        </Button>
      </div>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export support bundle</DialogTitle>
            <DialogDescription>
              Save recent logs, checks and settings to a file. Known secrets and personal paths are
              removed. Nothing is uploaded.
            </DialogDescription>
          </DialogHeader>
          <label htmlFor={checkbox} className="flex h-9 items-center gap-2 text-ui">
            <Checkbox
              id={checkbox}
              checked={include}
              disabled={running}
              onCheckedChange={setInclude}
            />
            Include conversations
          </label>
          <p className="text-sm text-muted-foreground">
            Conversations are excluded by default. Review the file before sharing it, especially if
            you include conversations.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button disabled={running} onClick={() => void run()}>
              {running ? "Exporting…" : "Export"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
