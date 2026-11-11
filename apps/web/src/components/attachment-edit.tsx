import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { DialogFooter } from "@/components/ui/dialog.tsx";
import { Textarea } from "@/components/ui/input.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

/*
 * A text file not sent yet (a long paste, most often), opened for editing: its whole text in a
 * monospace field, and Save once it has changed. What Save does with the text is the caller's.
 */

type Loaded = { state: "loading" } | { state: "failed" } | { state: "ready"; text: string };

export function EditableText(props: {
  file: File;
  frame: CSSProperties;
  /** The footer's other actions, before Save. */
  actions: ReactNode;
  onSave(text: string): void;
}) {
  const { file } = props;
  const [loaded, setLoaded] = useState<{ file: File; value: Loaded }>();
  const [draft, setDraft] = useState<string>();
  useEffect(() => {
    let live = true;
    file.text().then(
      (text) => live && setLoaded({ file, value: { state: "ready", text } }),
      () => live && setLoaded({ file, value: { state: "failed" } }),
    );
    return () => {
      live = false;
    };
  }, [file]);
  const value: Loaded = loaded?.file === file ? loaded.value : { state: "loading" };
  const original = value.state === "ready" ? value.text : undefined;
  const text = draft ?? original;
  const changed = text !== undefined && text !== original;
  return (
    <>
      {value.state === "loading" && <Skeleton className="h-40 w-full rounded-md" />}
      {value.state === "failed" && (
        <p className="py-8 text-center text-muted-foreground">
          Couldn't read this file on this device.
        </p>
      )}
      {text !== undefined && (
        <Textarea
          aria-label="File contents"
          value={text}
          onChange={(event) => setDraft(event.currentTarget.value)}
          spellCheck={false}
          wrap="off"
          style={props.frame}
          className="max-h-none bg-code p-3 font-mono text-xs leading-5 [field-sizing:fixed]"
        />
      )}
      <DialogFooter>
        {props.actions}
        <Button
          variant="primary"
          disabled={!changed}
          onClick={() => text !== undefined && props.onSave(text)}
        >
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
