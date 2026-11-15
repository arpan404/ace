import { spadePickCount, type SpadeDraft, type SpadeQuestion } from "@ace/ui-core/spade-chat";
import { useId } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";

const optionRow =
  "flex min-h-8 w-full min-w-0 items-start gap-3 rounded-md px-2 py-1.5 text-left text-base leading-5 transition-colors duration-(--motion-fast) focus-ring hover:bg-hover pointer-coarse:min-h-11 pointer-coarse:items-center";

/** A field in the card: one line in the card's well, at the answers' size. */
const well = "bg-chat-well text-base";

/** An option's digit key, at the row's end. */
function DigitKey(props: { digit: string | undefined }) {
  if (!props.digit) return null;
  return (
    <span
      aria-hidden
      className="ml-auto shrink-0 pl-3 text-xs leading-5 text-subtle-foreground tabular-nums pointer-coarse:hidden"
    >
      {props.digit}
    </span>
  );
}

/**
 * One question's inputs, by its kind: a one-line field that grows only as it is typed into;
 * options to pick (each with its digit key) and own words when the question takes them; checks
 * with a count; Yes and No; a number with its unit; a date. `onSubmit` is Enter in a field.
 */
export function QuestionInputs(props: {
  question: SpadeQuestion;
  draft: SpadeDraft;
  onDraft(draft: SpadeDraft): void;
  onSubmit(): void;
  disabled: boolean;
}) {
  const { question, draft, disabled } = props;
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
          className={cn(well, "mt-2 min-h-9")}
        />
      );
    case "choice":
    case "choices": {
      const picks =
        draft.kind === "picks" ? draft : { kind: "picks" as const, picked: [], other: "" };
      const many = question.kind === "choices";
      const toggle = (label: string) => {
        if (!many) return props.onDraft({ kind: "picks", picked: [label], other: "" });
        const picked = picks.picked.includes(label)
          ? picks.picked.filter((each) => each !== label)
          : [...picks.picked, label];
        props.onDraft({ ...picks, picked });
      };
      // A digit picks the option it names, while focus is on the list.
      const digit = (event: React.KeyboardEvent) => {
        const at = Number(event.key) - 1;
        const option = Number.isInteger(at) && at >= 0 ? question.options[at] : undefined;
        if (!option || event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        toggle(option.label);
      };
      const rows = question.options.map((option, index) => {
        const on = picks.picked.includes(option.label);
        const key = index < 9 ? `${index + 1}` : undefined;
        const words = (
          <span className="flex min-w-0 flex-col">
            <span className="wrap-anywhere">{option.label}</span>
            {option.detail && (
              <span className="text-ui leading-5 text-muted-foreground wrap-anywhere">
                {option.detail}
              </span>
            )}
          </span>
        );
        return many ? (
          <label
            key={option.label}
            className={cn(optionRow, "cursor-pointer", on && "bg-chat-well")}
          >
            <span className="flex h-5 shrink-0 items-center">
              <Checkbox
                checked={on}
                disabled={disabled}
                onCheckedChange={() => toggle(option.label)}
              />
            </span>
            {words}
            <DigitKey digit={key} />
          </label>
        ) : (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={option.label}
            disabled={disabled}
            onClick={() => toggle(option.label)}
            className={cn(optionRow, on && "bg-chat-well text-foreground")}
          >
            <span className="flex h-5 shrink-0 items-center">
              <span
                aria-hidden
                className={cn(
                  "size-4 rounded-full transition-shadow duration-(--motion-fast)",
                  on
                    ? "shadow-[inset_0_0_0_5px_var(--ring)]"
                    : "shadow-[inset_0_0_0_1.5px_var(--border-strong)]",
                )}
              />
            </span>
            {words}
            <DigitKey digit={key} />
          </button>
        );
      });
      return (
        <div className="mt-2 flex flex-col gap-0.5">
          {many ? (
            <div
              role="group"
              aria-label={question.prompt}
              onKeyDown={digit}
              className="-mx-2 flex flex-col"
            >
              {rows}
            </div>
          ) : (
            <div
              role="radiogroup"
              aria-label={question.prompt}
              onKeyDown={digit}
              className="-mx-2 flex flex-col"
            >
              {rows}
            </div>
          )}
          {question.other && (
            <Input
              aria-label={`${question.prompt}: something else`}
              placeholder="Something else"
              disabled={disabled}
              value={picks.other}
              onChange={(event) =>
                props.onDraft({
                  kind: "picks",
                  // One pick or own words: typing replaces a pick.
                  picked: many || !event.target.value ? picks.picked : [],
                  other: event.target.value,
                })
              }
              onKeyDown={enter}
              className={cn(well, "mt-1 h-9")}
            />
          )}
          {many && (
            <p className="mt-1.5 text-xs leading-4 text-subtle-foreground tabular-nums">
              {`${spadePickCount(question, picks)} picked`}
            </p>
          )}
        </div>
      );
    }
    case "confirm": {
      const value = draft.kind === "confirm" ? draft.value : undefined;
      return (
        <div className="-mx-2.5 mt-2 flex gap-1">
          {([true, false] as const).map((answer) => (
            <Button
              key={String(answer)}
              size="sm"
              variant={value === answer ? "secondary" : "ghost"}
              aria-pressed={value === answer}
              disabled={disabled}
              onClick={() => props.onDraft({ kind: "confirm", value: answer })}
            >
              {answer ? "Yes" : "No"}
            </Button>
          ))}
        </div>
      );
    }
    case "number":
    case "date":
      return (
        <div className="mt-2 flex items-center gap-2">
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
            className={cn(
              well,
              "h-9",
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
