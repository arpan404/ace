import { useId, useRef, useState, type ReactNode } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import { WordChoice } from "@/components/ui/word-choice.tsx";
import { cn } from "@/lib/cn.ts";
import { applePlatform } from "@/lib/keymap.ts";
import { applyChange, selectionOf } from "./apply-change.ts";
import { caretRect } from "./caret.ts";
import { CompletionList } from "./completion-list.tsx";
import { useMarkdownCompletions, type MarkdownCompletions } from "./completion-source.ts";
import { useCompletions } from "./use-completions.ts";
import { commandFor, type FormatCommand } from "./commands.ts";
import { FormatToolbar } from "./format-toolbar.tsx";
import { linkOnPaste } from "./inline.ts";
import { continueList, indentList } from "./lists.ts";

const heights = {
  /** A comment or review: four lines to start. */
  comment: "min-h-24 max-h-[50vh]",
  /** A page's main text (a new issue's description): room to write at length. */
  page: "min-h-56 max-h-[65vh]",
};

/**
 * Markdown writing as GitHub's comment box offers it: Write and Preview, a formatting toolbar
 * with the usual shortcuts, lists that continue on Enter and nest on Tab, and a web address
 * pasted over words linking them. Every edit goes through the browser's own undo. Preview
 * renders with `preview` (the page's own renderer) so it reads as the posted text will.
 * ⌘↵ submits: `onSubmit`, or else the form around it. Typing `@` suggests people and `#`
 * issues and pull requests, from `completions` or else the page's `MarkdownCompletionsProvider`.
 */
export function MarkdownEditor(props: {
  /** The text's accessible name ("Comment", "Description"). */
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  maxLength?: number | undefined;
  autoFocus?: boolean | undefined;
  size?: keyof typeof heights;
  onSubmit?: (() => void) | undefined;
  preview?: ((text: string) => ReactNode) | undefined;
  className?: string | undefined;
  /** Where `@` and `#` suggestions come from, over the page's own. */
  completions?: MarkdownCompletions | undefined;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const pageCompletions = useMarkdownCompletions();
  const suggest = useCompletions(field, props.completions ?? pageCompletions);
  const listId = useId();
  const run = (command: FormatCommand) => {
    const target = field.current;
    if (!target || props.disabled) return;
    applyChange(target, command.run(selectionOf(target)));
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (suggest.onKeyDown(event)) return;
    const target = event.currentTarget;
    const mod = applePlatform ? event.metaKey : event.ctrlKey;
    if (event.key === "Enter" && mod) {
      event.preventDefault();
      if (props.onSubmit) props.onSubmit();
      else target.form?.requestSubmit();
      return;
    }
    const command = commandFor(event, applePlatform);
    if (command) {
      event.preventDefault();
      run(command);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const change =
      event.key === "Enter" && !event.shiftKey
        ? continueList(selectionOf(target))
        : event.key === "Tab"
          ? indentList(selectionOf(target), event.shiftKey)
          : undefined;
    if (!change) return;
    event.preventDefault();
    applyChange(target, change);
  };
  const writing = tab === "write";
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-md shadow-[inset_0_0_0_1px_var(--border-strong)] transition-shadow duration-(--motion-fast)",
        "has-[textarea:focus-visible]:shadow-[inset_0_0_0_1px_var(--focus,var(--ring))]",
        props.disabled && "opacity-60",
        props.className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-1 pt-1">
        <WordChoice
          label={`${props.label}: write or preview`}
          value={tab}
          options={[
            { value: "write", label: "Write" },
            { value: "preview", label: "Preview" },
          ]}
          onValueChange={(next) => {
            setTab(next);
            if (next === "write") requestAnimationFrame(() => field.current?.focus());
          }}
        />
        {writing && <FormatToolbar disabled={props.disabled} onRun={run} />}
      </div>
      <textarea
        ref={field}
        aria-label={props.label}
        hidden={!writing}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        maxLength={props.maxLength}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- Only where the field opens to write in.
        autoFocus={props.autoFocus}
        // A text box that suggests (ARIA's textbox with aria-autocomplete): it keeps its own
        // role, and names the open list and its highlighted row.
        aria-autocomplete={suggest.match ? "list" : undefined}
        aria-controls={suggest.match ? listId : undefined}
        aria-activedescendant={suggest.match ? `${listId}-${suggest.active}` : undefined}
        onChange={(event) => {
          props.onChange(event.currentTarget.value);
          suggest.update();
        }}
        onSelect={suggest.update}
        onBlur={suggest.close}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const change = linkOnPaste(
            selectionOf(event.currentTarget),
            event.clipboardData.getData("text/plain"),
          );
          if (!change) return;
          event.preventDefault();
          applyChange(event.currentTarget, change);
        }}
        className={cn(
          "block w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-ui leading-normal text-foreground [field-sizing:content] placeholder:text-subtle-foreground focus:outline-none",
          heights[props.size ?? "comment"],
        )}
      />
      {writing && suggest.match && (
        <CompletionList
          id={listId}
          label={suggest.match.kind === "mention" ? "People" : "Issues and pull requests"}
          items={suggest.items}
          active={suggest.active}
          anchor={() => {
            const target = field.current;
            const at = suggest.match?.from ?? 0;
            return target ? caretRect(target, at) : new DOMRect();
          }}
          onHighlight={suggest.setActive}
          onChoose={suggest.choose}
          onDismiss={suggest.close}
        />
      )}
      {!writing && (
        <div
          role="region"
          aria-label={`${props.label} preview`}
          className={cn("overflow-y-auto px-3 py-2", heights[props.size ?? "comment"])}
        >
          {props.value.trim() ? (
            (props.preview?.(props.value) ?? <Prose text={props.value} className="text-ui" />)
          ) : (
            <p className="text-ui text-subtle-foreground">Nothing to preview</p>
          )}
        </div>
      )}
    </div>
  );
}
