import { useId, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";

/** The person's message, as the thread shows it: a tailless bubble at the answers' size. */
const promptBubble =
  "relative max-w-[80%] min-w-0 overflow-hidden rounded-lg bg-bubble px-3 py-2 font-prose text-prose wrap-break-word whitespace-pre-wrap";

/**
 * The automation's prompt as the person's message. With `onSave`, it edits in place: Edit under
 * the bubble turns it into a box of the same size, ⌘/Ctrl+Enter or Save keeps the change and
 * Escape or Cancel puts the old text back.
 */
export function PromptMessage(props: {
  prompt: string;
  editing: boolean;
  onEditingChange(editing: boolean): void;
  onSave: ((prompt: string) => Promise<boolean>) | undefined;
  disabled?: boolean;
}) {
  const [text, setText] = useState(props.prompt);
  const [saving, setSaving] = useState(false);
  const hintId = useId();
  const trimmed = text.trim();
  const open = () => {
    setText(props.prompt);
    props.onEditingChange(true);
  };
  const save = async () => {
    if (!props.onSave || !trimmed || saving) return;
    if (trimmed === props.prompt.trim()) return props.onEditingChange(false);
    setSaving(true);
    const saved = await props.onSave(trimmed);
    setSaving(false);
    if (saved) props.onEditingChange(false);
  };

  if (props.editing && props.onSave)
    return (
      <div className="flex flex-col items-end gap-1.5">
        <textarea
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- Edit asked for this box
          autoFocus
          aria-label="Prompt"
          aria-describedby={hintId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              props.onEditingChange(false);
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
          className={cn(
            promptBubble,
            "field-sizing-content max-h-[50vh] w-full max-w-full resize-none outline-none focus-ring",
          )}
        />
        <p id={hintId} className="sr-only">
          Command or Control Enter saves, Escape cancels.
        </p>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => props.onEditingChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!trimmed || saving || props.disabled}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>
    );

  return (
    <div className="group/prompt flex flex-col items-end gap-1">
      <div aria-label="Prompt" role="group" className={promptBubble}>
        {props.prompt}
      </div>
      {props.onSave && (
        <button
          type="button"
          disabled={props.disabled}
          onClick={open}
          className="rounded-xs px-1 text-xs text-muted-foreground opacity-0 transition-opacity duration-(--motion-fast) group-hover/prompt:opacity-100 focus-ring hover:text-foreground focus-visible:opacity-100 disabled:pointer-events-none [@media(hover:none)]:opacity-100"
        >
          Edit
        </button>
      )}
    </div>
  );
}
