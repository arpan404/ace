import { isMarkdownPath } from "@ace/ui-core";
import type { EditorTab } from "@ace/ui-core/editor-workbench";
import { WordChoice } from "@/components/ui/word-choice.tsx";

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
