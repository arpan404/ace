import type { DraftAnnotations } from "@ace/ui-core";
import { render, screen, waitFor, act } from "@testing-library/react";
import { createRef, type RefObject } from "react";
import { expect } from "vitest";
import { ToastProvider } from "@/components/ui/toast.tsx";
import {
  AnnotationChip,
  useAnnotationPort,
  useDraftAnnotations,
} from "@/features/annotations/index.ts";
import { useEditorAnnotations } from "../annotate.tsx";
import { CodeEditor } from "../editor.tsx";
import type { EditorHandle } from "../types.ts";

/*
 * A thread for annotation tests: its composer's draft (the real store and chip) and one editor
 * per file, each with the annotation layer, as the Deck mounts them. Tests only.
 */

export const threadId = "thread-1";

export interface File {
  path: string;
  text: string;
  readOnly?: boolean;
  side?: "old" | "new";
}

interface Props {
  files: File[];
  restored?: DraftAnnotations | undefined;
  refs: Map<string, RefObject<EditorHandle | null>>;
  sent: string[];
  drafts: (DraftAnnotations | undefined)[];
}

function Thread(props: Props) {
  const annotations = useDraftAnnotations({
    restored: props.restored,
    upload: async () => ({ sha256: "0".repeat(64) }),
    release: async () => {},
  });
  useAnnotationPort(threadId, annotations, () => {});
  props.drafts.push(annotations.draft);
  return (
    <div>
      {props.files.map((file) => (
        <Annotated key={file.path} file={file} editorRef={props.refs.get(file.path)} />
      ))}
      <AnnotationChip threadId={threadId} annotations={annotations} />
      <button
        type="button"
        onClick={() => {
          const handOff = annotations.handOff();
          if (handOff?.part.type === "text") props.sent.push(handOff.part.text);
        }}
      >
        Send
      </button>
    </div>
  );
}

let counter = 0;
const nextId = () => `annotation-${(counter += 1)}`;

function Annotated(props: { file: File; editorRef: RefObject<EditorHandle | null> | undefined }) {
  const { file, editorRef } = props;
  const layer = useEditorAnnotations({ threadId, path: file.path, side: file.side, newId: nextId });
  return (
    <CodeEditor
      ref={editorRef}
      path={file.path}
      label={`Editor ${file.path}`}
      text={file.text}
      readOnly={file.readOnly}
      layer={layer}
      commitAfter={20}
      highlightDelay={60_000}
      statusLine={false}
    />
  );
}

/** Opens a thread with these files; each editor's handle by path, and what Send handed off. */
export async function openThread(files: File[], restored?: DraftAnnotations) {
  const refs = new Map(files.map((file) => [file.path, createRef<EditorHandle>()]));
  const sent: string[] = [];
  const drafts: (DraftAnnotations | undefined)[] = [];
  const view = render(
    <ToastProvider>
      <Thread files={files} restored={restored} refs={refs} sent={sent} drafts={drafts} />
    </ToastProvider>,
  );
  for (const file of files) {
    const name = file.path.split("/").at(-1) ?? file.path;
    await screen.findByRole("textbox", { name });
    await waitFor(() => expect(refs.get(file.path)?.current).toBeTruthy());
  }
  const editor = (path = files[0]?.path ?? "") => {
    const handle = refs.get(path)?.current;
    if (!handle) throw new Error(`No editor for ${path}`);
    return handle;
  };
  const rerender = (next: File[]) =>
    view.rerender(
      <ToastProvider>
        <Thread files={next} restored={restored} refs={refs} sent={sent} drafts={drafts} />
      </ToastProvider>,
    );
  return { ...view, editor, sent, drafts, rerender };
}

/** Selects from (line, column) to (line, column), 0-based, in the editor. */
export function select(handle: EditorHandle, from: [number, number], to: [number, number]) {
  act(() => {
    handle.focus();
    handle.setSelections([
      { anchor: { line: from[0], column: from[1] }, head: { line: to[0], column: to[1] } },
    ]);
  });
}

/** The gutter's numbered markers drawn now, as "number@line" (1-based line from the row). */
export function markers(container: HTMLElement = document.body): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-code-annotation]")].map((marker) => {
    const top = Number.parseFloat(marker.style.top);
    return `${marker.dataset.codeAnnotation}@${Math.round((top - 3) / 22) + 1}${marker.dataset.outdated ? " outdated" : ""}`;
  });
}
