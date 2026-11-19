import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { CodeEditor, type EditorHandle } from "@/features/editor";
import { Button } from "@/components/ui/button.tsx";
import { checkoutError, type FileContent } from "./checkout-source.ts";
import { fileManagement } from "./file-management-source.ts";
import { useCheckoutSource } from "./use-checkout.ts";

/** The tab (and with it the stored workspace) gets the typed text once typing pauses this long. */
const keepAfter = 400;

export interface FileDraft {
  text: string;
  original: string;
  version: string;
}

/**
 * A checkout file being edited: the editor fills the tab, with the Save, conflict and draft
 * behaviour the plain-textarea editor had. The text is read from the editor only when it is
 * needed (a pause, a save, leaving the tab), never copied on a keystroke.
 */
export function FileEditor(props: {
  threadId: string;
  path: string;
  draft: FileDraft;
  /** Long lines wrap at the editor's width, from the Files tab's preference. */
  wrap: boolean;
  /** Alt+Z in the editor: the Files tab's wrap preference flips. */
  onToggleWrap(): void;
  onChange(draft: FileDraft): void;
  onClose(): void;
  onSaved(content: Extract<FileContent, { kind: "text" }>): void;
  onOverflowEnd?(overflow: boolean): void;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const source = useCheckoutSource();
  const editor = useRef<EditorHandle>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string>();
  const [error, setError] = useState<string>();
  const [dirty, setDirty] = useState(props.draft.text !== props.draft.original);
  const [initial] = useState(props.draft.text);
  const closing = useRef(false);
  const savedVersion = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);

  const keepNow = () => {
    const text = editor.current?.text();
    if (text === undefined || text === props.draft.text) return;
    props.onChange({ ...props.draft, text });
  };
  const keep = useEffectEvent(keepNow);

  const scheduleKeep = () => {
    if (settle.current !== undefined) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = undefined;
      keep();
    }, keepAfter);
  };

  useEffect(() => {
    const flush = () => {
      if (settle.current !== undefined) clearTimeout(settle.current);
      if (!closing.current) keep();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      // Leaving the tab (another file, another view) keeps what was typed.
      flush();
    };
  }, []);

  const save = async (expected = props.draft.version) => {
    if (busy) return;
    if (settle.current !== undefined) clearTimeout(settle.current);
    const text = editor.current?.text() ?? initial;
    setBusy(true);
    setError(undefined);
    setConflict(undefined);
    closing.current = true;
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
      closing.current = false;
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
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            closing.current = true;
            props.onClose();
          }}
        >
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
          ref={editor}
          text={initial}
          path={props.path}
          readOnly={busy}
          wrap={props.wrap}
          onToggleWrap={props.onToggleWrap}
          label={`Editing ${props.path}`}
          focusOnMount
          onEdit={() => {
            // Dirtiness is the document's edit count, not a text comparison on every key.
            setDirty((editor.current?.version() ?? 0) > savedVersion.current);
            scheduleKeep();
          }}
          onBlur={keepNow}
          onHorizontalOverflow={props.onOverflowEnd}
          onTextDispose={(text) => {
            if (!closing.current && text !== props.draft.text)
              props.onChange({ ...props.draft, text });
          }}
          onSave={() => void save()}
        />
      </div>
    </div>
  );
}
