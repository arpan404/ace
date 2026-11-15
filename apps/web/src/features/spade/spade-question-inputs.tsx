import { spadePickCount, type SpadeDraft, type SpadeQuestion } from "@ace/ui-core/spade-chat";
import { useId } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";

const optionRow =
  "flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left text-ui transition-colors duration-(--motion-fast) focus-ring hover:bg-hover";

/**
 * One question's inputs, by its kind: a text box; options to pick (each with its digit key) and
 * own words when the question takes them; checks with a count; Yes and No; a number with its
 * unit; a date. `onSubmit` is Enter in a one-line field.
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
          rows={2}
          placeholder={question.placeholder ?? "Your answer"}
          disabled={disabled}
          value={draft.kind === "text" ? draft.text : ""}
          onChange={(event) => props.onDraft({ kind: "text", text: event.target.value })}
          onKeyDown={enter}
          className="mt-1.5 bg-background"
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
              <span className="text-xs text-muted-foreground wrap-anywhere">{option.detail}</span>
            )}
          </span>
        );
        return many ? (
          <label
            key={option.label}
            className={cn(optionRow, "cursor-pointer items-center", on && "bg-active")}
          >
            <Checkbox
              checked={on}
              disabled={disabled}
              onCheckedChange={() => toggle(option.label)}
            />
            {words}
            {key && (
              <span aria-hidden className="ml-auto text-xs text-subtle-foreground">
                {key}
              </span>
            )}
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
            className={cn(optionRow, on && "bg-active text-foreground")}
          >
            {key && (
              <span aria-hidden className="w-3 shrink-0 text-xs text-subtle-foreground">
                {key}
              </span>
            )}
            {words}
          </button>
        );
      });
      return (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {many && (
            <p className="px-2 text-xs text-muted-foreground">
              {`${spadePickCount(question, picks)} picked`}
            </p>
          )}
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
              className="mt-1 bg-background"
            />
          )}
        </div>
      );
    }
    case "confirm": {
      const value = draft.kind === "confirm" ? draft.value : undefined;
      return (
        <div className="-mx-2 mt-1 flex gap-1">
          {([true, false] as const).map((answer) => (
            <Button
              key={String(answer)}
              size="xs"
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
        <div className="mt-1.5 flex items-center gap-2">
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
            className="w-44 bg-background"
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
