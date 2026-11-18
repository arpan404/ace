import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";
import { CodeEditor } from "@/features/editor";
import { Button } from "@/components/ui/button.tsx";
import { checkoutError, type FileContent } from "./checkout-source.ts";
import { fileManagement } from "./file-management-source.ts";
import { useCheckoutSource, useSettled } from "./use-checkout.ts";

/** The tab (and with it the stored workspace) gets the typed text once typing pauses this long. */
const keepAfter = 400;

export interface FileDraft {
  text: string;
  original: string;
  version: string;
}

/**
 * A checkout file being edited: the editor fills the tab, with the Save, conflict and draft
 * behaviour the plain-textarea editor had. The text lives here while it is typed because the
 * tab's data is stored with the whole workspace, so handing it each keystroke would serialize
 * every tab of every thread per key.
 */
export function FileEditor(props: {
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
  const [initial] = useState(props.draft.text);
  const [text, setText] = useState(initial);
  const settled = useSettled(text, keepAfter);
  const keep = (next: string) => {
    if (next !== props.draft.text) props.onChange({ ...props.draft, text: next });
  };
  const keepSettled = useEffectEvent(keep);
  useEffect(() => keepSettled(settled), [settled]);
  const dirty = text !== props.draft.original;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  // Leaving the editor (another tab, the page going away) keeps what was typed at once.
  const flush = useEffectEvent(() => keep(text));
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

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
        text,
      });
      if (!result.version) throw new Error("Couldn't confirm the saved file. Refresh to check it.");
      props.onSaved({
        kind: "text",
        text,
        size: new TextEncoder().encode(text).length,
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
      <div className="min-h-0 flex-1">
        <CodeEditor
          text={initial}
          path={props.path}
          readOnly={busy}
          label={`Editing ${props.path}`}
          focusOnMount
          onTextChange={(next) => {
            setText(next);
            // The tab's close warning reads the draft: it learns at once that it is edited.
            if ((next !== props.draft.original) !== (props.draft.text !== props.draft.original))
              keep(next);
          }}
          onSave={() => void save()}
        />
      </div>
    </div>
  );
}
