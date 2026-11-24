import type { SpadeDraft, SpadeQuestion } from "@ace/ui-core/spade-chat";
import { useId } from "react";
import { ChoiceInputs } from "./spade-question-choices.tsx";
import { LetterKey, optionChosen, optionLetter, optionRow, well } from "./spade-question-parts.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";

/**
 * One question's inputs, by its kind: a one-line field that grows only as it is typed into;
 * options to pick (each with its digit key), and Something else… for own words; checks with a
 * count; Yes and No; a number with its unit; a date. `onSubmit` is Enter in a field.
 */
export function QuestionInputs(props: {
  question: SpadeQuestion;
  draft: SpadeDraft;
  onDraft(draft: SpadeDraft): void;
  onSubmit(): void;
  disabled: boolean;
  /** The last answer was refused: the field says so with its edge, the reason reads under it. */
  refused: boolean;
}) {
  const { question, draft, disabled } = props;
  const invalid = props.refused || undefined;
  const id = useId();
  const enter = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      props.onSubmit();
    }
  };
  switch (question.kind) {
    case "text":
      return (
        <Textarea
          aria-label={question.prompt}
          rows={1}
          placeholder={question.placeholder ?? "Your answer"}
          disabled={disabled}
          value={draft.kind === "text" ? draft.text : ""}
          onChange={(event) => props.onDraft({ kind: "text", text: event.target.value })}
          onKeyDown={enter}
          aria-invalid={invalid}
          className={cn(well, "min-h-10 py-2.5")}
        />
      );
    case "choice":
    case "choices":
      return (
        <ChoiceInputs
          question={question}
          draft={draft}
          onDraft={props.onDraft}
          onSubmit={props.onSubmit}
          disabled={disabled}
          invalid={invalid}
          enter={enter}
        />
      );
    case "confirm": {
      // In a card of several, Yes and No are a pick-one pair; a lone one answers from the footer.
      const value = draft.kind === "confirm" ? draft.value : undefined;
      return (
        <div role="radiogroup" aria-label={question.prompt} className="flex flex-col gap-2">
          {([true, false] as const).map((answer) => {
            const on = value === answer;
            return (
              <button
                key={String(answer)}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={disabled}
                onClick={() => props.onDraft({ kind: "confirm", value: answer })}
                className={cn(optionRow, on && optionChosen)}
              >
                <LetterKey letter={optionLetter(answer ? 0 : 1)} on={on} />
                {answer ? "Yes" : "No"}
              </button>
            );
          })}
        </div>
      );
    }
    case "number":
    case "date":
      return (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            aria-label={question.prompt}
            type={question.kind === "number" ? "number" : question.time ? "datetime-local" : "date"}
            inputMode={question.kind === "number" ? "decimal" : undefined}
            min={question.kind === "number" ? question.min : undefined}
            max={question.kind === "number" ? question.max : undefined}
            disabled={disabled}
            value={draft.kind === "field" ? draft.text : ""}
            onChange={(event) => props.onDraft({ kind: "field", text: event.target.value })}
            onKeyDown={enter}
            aria-invalid={invalid}
            className={cn(
              well,
              "h-10",
              question.kind === "number" ? "w-24" : question.time ? "w-56" : "w-44",
            )}
          />
          {question.kind === "number" && question.unit && (
            <label htmlFor={id} className="text-ui text-muted-foreground">
              {question.unit}
            </label>
          )}
        </div>
      );
  }
}
