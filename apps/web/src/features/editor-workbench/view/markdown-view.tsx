import { fileLanguage } from "@ace/ui-core";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import { editorStatus, type EditorStatus } from "@/features/editor";
import type { TextBuffer } from "../buffers/index.ts";

/* A Markdown tab shown rendered (spec 40): its own chunk, so markit's prose loads only then. */

/**
 * The buffer's text rendered, unsaved edits included, read again whenever the buffer changes.
 * The status line keeps speaking for the file meanwhile: its source caret, indent, line ending
 * and language, as the source view would report them.
 */
export function MarkdownPreview(props: {
  buffer: TextBuffer;
  path: string;
  onStatus(status: EditorStatus | undefined): void;
}) {
  const { buffer, path, onStatus } = props;
  const subscribe = useCallback((changed: () => void) => buffer.subscribe(changed), [buffer]);
  const text = useSyncExternalStore(subscribe, () => buffer.document()?.text() ?? "");
  // A reload or a merge brings a new document: the status is read from it again.
  const doc = useSyncExternalStore(subscribe, () => buffer.document());
  useEffect(() => {
    if (!doc) return undefined;
    onStatus(
      editorStatus({
        selections: doc.selections(),
        primary: doc.primarySelection(),
        indent: doc.indent(),
        lineEnding: doc.lineEnding(),
        language: fileLanguage(path),
        languageChosen: false,
        whitespace: false,
        readOnly: false,
      }),
    );
    return () => onStatus(undefined);
  }, [doc, path, onStatus]);
  return (
    <div className="@container min-h-0 flex-1 overflow-auto" tabIndex={-1}>
      <article className="mx-auto w-full max-w-[760px] px-4 py-4 text-base leading-[1.6] @[560px]:px-8 @[560px]:py-6">
        <Prose text={text} />
      </article>
    </div>
  );
}
