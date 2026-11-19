import { spadePickCount, type SpadeDraft, type SpadeQuestion } from "@ace/ui-core/spade-chat";
import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";

/** An option: a 40px row with its edge, the chosen one's edge in ink. */
const optionRow =
  "flex min-h-10 w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-base leading-5 shadow-[inset_0_0_0_1px_var(--border-strong)] transition-[background-color,box-shadow] duration-(--motion-fast) focus-ring hover:bg-hover pointer-coarse:min-h-11 pointer-coarse:items-center";
const optionChosen = "text-foreground shadow-[inset_0_0_0_1.5px_var(--foreground)]";

/** A field in the card: 40px in the card's well, at the answers' size; refused, its edge is red. */
const well =
  "rounded-lg bg-chat-well px-3 text-base shadow-[inset_0_0_0_1px_var(--border-strong)] aria-invalid:shadow-[inset_0_0_0_1px_var(--destructive)]";

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

/** A pick-one option's circle, filled in ink once chosen. */
function Radio(props: { on: boolean }) {
  return (
    <span className="flex h-5 shrink-0 items-center">
      <span
        aria-hidden
        className={cn(
          "size-4 rounded-full transition-shadow duration-(--motion-fast)",
          props.on
            ? "shadow-[inset_0_0_0_5px_var(--foreground)]"
            : "shadow-[inset_0_0_0_1.5px_var(--border-strong)]",
        )}
      />
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
      // A digit picks the option it names, while focus is on the list, and focus goes with it,
      // so Enter next goes on rather than picking whatever focus was left on.
      const digit = (event: React.KeyboardEvent<HTMLElement>) => {
        const at = Number(event.key) - 1;
        const option = Number.isInteger(at) && at >= 0 ? question.options[at] : undefined;
        if (!option || event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        toggle(option.label);
        const choices = event.currentTarget.querySelectorAll<HTMLElement>(
          '[role="radio"], [role="checkbox"]',
        );
        choices[at]?.focus({ preventScroll: true });
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
          <label key={option.label} className={cn(optionRow, "cursor-pointer", on && optionChosen)}>
            <span className="flex h-5 shrink-0 items-center">
              <Checkbox
                checked={on}
                disabled={disabled}
                onCheckedChange={() => toggle(option.label)}
                // The same size and edge as a pick-one option's circle, filled in ink once checked.
                className="size-4 rounded-xs shadow-[inset_0_0_0_1.5px_var(--border-strong)] data-checked:bg-foreground data-checked:shadow-none [&_svg]:text-background"
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
            onKeyDown={(event) => {
              // Enter on the option already picked goes on, as Enter in a field does.
              if (event.key !== "Enter" || !on) return;
              event.preventDefault();
              props.onSubmit();
            }}
            className={cn(optionRow, on && optionChosen)}
          >
            <Radio on={on} />
            {words}
            <DigitKey digit={key} />
          </button>
        );
      });
      return (
        <div className="flex flex-col gap-2">
          {many ? (
            <div
              role="group"
              aria-label={question.prompt}
              onKeyDown={digit}
              className="flex flex-col gap-2"
            >
              {rows}
            </div>
          ) : (
            <div
              role="radiogroup"
              aria-label={question.prompt}
              onKeyDown={digit}
              className="flex flex-col gap-2"
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
              aria-invalid={invalid}
              className={cn(well, "h-10")}
            />
          )}
          {many && (
            <p className="text-xs leading-4 text-subtle-foreground tabular-nums">
              {`${spadePickCount(question, picks)} picked`}
            </p>
          )}
        </div>
      );
    }
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
                <Radio on={on} />
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
