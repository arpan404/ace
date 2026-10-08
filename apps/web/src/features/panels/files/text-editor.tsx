import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { FileContent } from "./checkout-source.ts";
import { checkoutError } from "./checkout-source.ts";
import { fileManagement } from "./file-management-source.ts";
import { useCheckoutSource } from "./use-checkout.ts";

export interface FileDraft {
  text: string;
  original: string;
  version: string;
}
export function TextEditor(props: {
  threadId: string;
  path: string;
  draft: FileDraft;
  onChange(draft: FileDraft): void;
  onClose(): void;
  onSaved(content: Extract<FileContent, { kind: "text" }>): void;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const source = useCheckoutSource();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string>();
  const [error, setError] = useState<string>();
  const dirty = props.draft.text !== props.draft.original;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const save = async (expected = props.draft.version) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setConflict(undefined);
    try {
      const result = await fileManagement(client, props.threadId).mutate({
        op: "write",
        path: props.path,
        expected,
        text: props.draft.text,
      });
      if (!result.version) throw new Error("Couldn't confirm the saved file. Refresh to check it.");
      props.onSaved({
        kind: "text",
        text: props.draft.text,
        size: new TextEncoder().encode(props.draft.text).length,
        version: result.version,
      });
      void queries.invalidateQueries({ queryKey: ["checkout"] });
    } catch (failure) {
      const parsed = checkoutError(failure);
      if (parsed.code === "CONFLICT") {
        try {
          const latest = await source.stat(props.threadId, props.path);
          if (latest.version) setConflict(latest.version);
          else setError("This file was deleted. Copy your edits, then create a new file.");
        } catch (readError) {
          setError(checkoutError(readError).message);
        }
      } else setError(parsed.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b px-3">
        <span role="status" className="mr-auto text-xs text-muted-foreground">
          {dirty ? "Unsaved changes" : "Editing"}
        </span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={props.onClose}>
          {dirty ? "Discard changes" : "Cancel"}
        </Button>
        <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-ui">
          <span className="flex-1 text-muted-foreground">
            {props.path} changed since you opened it. Replace it?
          </span>
          <Button size="sm" disabled={busy} onClick={() => void save(conflict)}>
            Replace
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConflict(undefined)}>
            Keep editing
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="px-3 py-2 text-ui text-status-failed">
          {error}
        </p>
      )}
      <textarea
        aria-label={`Edit ${props.path}`}
        spellCheck={false}
        disabled={busy}
        value={props.draft.text}
        onChange={(event) => props.onChange({ ...props.draft, text: event.target.value })}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            void save();
          }
        }}
        className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-ui leading-6 text-foreground outline-none"
      />
    </div>
  );
}
