import { TrashIcon } from "@ace/icons";
import type { CodeAnnotationIntent } from "@ace/ui-core";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Popover, PopoverContent } from "@/components/ui/popover.tsx";
import { WordChoice } from "@/components/ui/word-choice.tsx";
import { MarkerNumber, PlaceBadge } from "./marker.tsx";

type Anchor = PopoverPrimitive.Positioner.Props["anchor"];
type Intent = CodeAnnotationIntent | "note";

const intents: readonly { value: Intent; label: string }[] = [
  { value: "note", label: "Note" },
  { value: "ask", label: "Ask" },
  { value: "fix", label: "Fix" },
  { value: "explain", label: "Explain" },
];

/**
 * Writing an annotation's comment, beside the code it is on: the same pill the Browser's page
 * opens on an element, as a popover. A new one saves on Enter (Shift+Enter starts a line); an
 * existing one shows its number and can be deleted. What the person wants (a note, a question, a
 * fix, an explanation) is one word above the comment; a note needs words, the others don't.
 */
export function CommentPopover(props: {
  anchor: Anchor;
  /** The lines it covers, as the badge reads: "12–18". */
  lines: string;
  /** An annotation being edited; undefined while writing a new one. */
  number?: number | undefined;
  comment: string;
  intent: CodeAnnotationIntent | undefined;
  /** Its code changed or was deleted since it was made. */
  outdated?: boolean | undefined;
  onSave(comment: string, intent: CodeAnnotationIntent | undefined): void;
  onCancel(): void;
  onDelete?: (() => void) | undefined;
}) {
  const [comment, setComment] = useState(props.comment);
  const [intent, setIntent] = useState<Intent>(props.intent ?? "note");
  const chosen = intent === "note" ? undefined : intent;
  const ready = !!comment.trim() || !!chosen;
  const save = () => {
    if (ready) props.onSave(comment.trim(), chosen);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    save();
  };
  const label = props.number === undefined ? "New annotation" : `Annotation ${props.number}`;
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <PopoverContent
        anchor={props.anchor}
        side="bottom"
        align="start"
        aria-label={label}
        className="flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-1.5 p-1.5"
      >
        <div className="flex items-center gap-1.5 pl-1">
          {props.number !== undefined && <MarkerNumber number={props.number} />}
          <PlaceBadge text={props.lines} />
          <WordChoice<Intent>
            label="What you want"
            value={intent}
            options={intents}
            onValueChange={setIntent}
            className="ml-auto"
          />
        </div>
        {props.outdated && (
          <p className="px-1 text-xs text-subtle-foreground">
            The code this pointed at changed or was deleted.
          </p>
        )}
        <textarea
          aria-label="Comment"
          // The popover opens because the person asked to write here.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          rows={2}
          maxLength={4000}
          value={comment}
          placeholder={chosen === "ask" ? "Ask a question…" : "Add a comment…"}
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={onKeyDown}
          className="block max-h-28 min-h-11 w-full resize-none bg-transparent px-1 text-ui text-foreground outline-none [field-sizing:content] placeholder:text-subtle-foreground"
        />
        <div className="flex items-center gap-1.5">
          {props.onDelete && (
            <IconButton
              icon={TrashIcon}
              label={`Delete annotation ${props.number ?? ""}`.trim()}
              tip="Delete"
              size="sm"
              onClick={props.onDelete}
            />
          )}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!ready} onClick={save}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
