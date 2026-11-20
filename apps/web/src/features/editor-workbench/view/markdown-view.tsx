import { isMarkdownPath } from "@ace/ui-core";
import type { EditorTab } from "@ace/ui-core/editor-workbench";
import { useEffect, useState } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import { WordChoice } from "@/components/ui/word-choice.tsx";
import type { TextBuffer } from "../buffers/index.ts";

/*
 * Spec 40: a Markdown file shows rendered by default, with a Preview / Source choice at the
 * breadcrumb line's right end. The choice is the tab's own (its view state, stored with the
 * layout), so each tab of the file keeps what it last showed.
 */

export type MarkdownShow = "preview" | "source";

const choices = [
  { value: "preview", label: "Preview" },
  { value: "source", label: "Source" },
] as const;

/** What a tab shows for its file: undefined for anything but Markdown. */
export function markdownShow(tab: EditorTab | undefined): MarkdownShow | undefined {
  if (!tab || !isMarkdownPath(tab.path)) return undefined;
  return tab.view?.["markdown"] === "source" ? "source" : "preview";
}

export function MarkdownChoice(props: { value: MarkdownShow; onChange(next: MarkdownShow): void }) {
  return (
    <WordChoice
      label="Show Markdown as"
      value={props.value}
      options={choices}
      onValueChange={props.onChange}
      className="-my-px ml-auto shrink-0 gap-0.5"
    />
  );
}

/** The buffer's text rendered, unsaved edits included, read again whenever the buffer changes. */
export function MarkdownPreview(props: { buffer: TextBuffer }) {
  const { buffer } = props;
  const [text, setText] = useState(() => buffer.document()?.text() ?? "");
  useEffect(() => {
    setText(buffer.document()?.text() ?? "");
    return buffer.subscribe(() => setText(buffer.document()?.text() ?? ""));
  }, [buffer]);
  return (
    <div className="min-h-0 flex-1 overflow-auto" tabIndex={-1}>
      <article className="mx-auto w-full max-w-[760px] px-8 py-6 text-base leading-[1.6]">
        <Prose text={text} />
      </article>
    </div>
  );
}
