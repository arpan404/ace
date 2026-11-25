import { spadePickCount, type SpadeDraft, type SpadeQuestion } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { cn } from "@/lib/cn.ts";
import { LetterKey, optionChosen, optionLetter, optionRow } from "./spade-question-parts.tsx";

type Choice = Extract<SpadeQuestion, { kind: "choice" | "choices" }>;
type Picks = Extract<SpadeDraft, { kind: "picks" }>;

/** A checkbox at a pick-one option's circle size and edge, filled in ink once checked. */
const box =
  "size-4 rounded-xs shadow-[inset_0_0_0_1.5px_var(--border-strong)] data-checked:bg-foreground data-checked:shadow-none [&_svg]:text-background";

/** The field inside the Something else… row: bare, the row is its edge. */
const ownField =
  "min-w-0 flex-1 bg-transparent text-base leading-5 text-foreground outline-none placeholder:text-subtle-foreground";

/**
 * A choice question's options, one pick or several, each with its digit key, then Something
 * else…, always offered: picked, it opens a field in its row and the words typed there are the
 * answer (one more pick, for several). The digit after the options' opens the field.
 */
export function ChoiceInputs(props: {
  question: Choice;
  draft: SpadeDraft;
  onDraft(draft: SpadeDraft): void;
  onSubmit(): void;
  disabled: boolean;
  invalid: true | undefined;
  enter(event: React.KeyboardEvent): void;
}) {
  const { question, disabled } = props;
  const picks: Picks =
    props.draft.kind === "picks" ? props.draft : { kind: "picks", picked: [], other: "" };
  const many = question.kind === "choices";
  // Open while it has words, or once picked; focus goes to it when the person opens it.
  const [ownOpen, setOwnOpen] = useState(picks.other !== "");
  const [focusOwn, setFocusOwn] = useState(false);
  const toggle = (label: string) => {
    if (!many) {
      setOwnOpen(false);
      return props.onDraft({ kind: "picks", picked: [label], other: "" });
    }
    const picked = picks.picked.includes(label)
      ? picks.picked.filter((each) => each !== label)
      : [...picks.picked, label];
    props.onDraft({ ...picks, picked });
  };
  const openOwn = () => {
    setOwnOpen(true);
    setFocusOwn(true);
    // One pick: own words replace an option picked.
    if (!many) props.onDraft({ kind: "picks", picked: [], other: picks.other });
  };
  const closeOwn = () => {
    setOwnOpen(false);
    props.onDraft({ ...picks, other: "" });
  };
  const ownDigit = question.options.length < 26 ? question.options.length + 1 : undefined;
  // A digit picks the option it names, while focus is on the list, and focus goes with it, so
  // Enter next goes on rather than picking whatever focus was left on. The last opens the field.
  const digit = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // A letter (A, B, C…) or a digit names the option, in order; the one after the options opens
    // the field.
    const at = /^[a-z]$/i.test(event.key)
      ? event.key.toUpperCase().charCodeAt(0) - 65
      : Number(event.key) - 1;
    if (!Number.isInteger(at) || at < 0) return;
    const option = question.options[at];
    if (option) {
      event.preventDefault();
      toggle(option.label);
      const choices = event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="radio"], [role="checkbox"]',
      );
      choices[at]?.focus({ preventScroll: true });
    } else if (at + 1 === ownDigit) {
      event.preventDefault();
      openOwn();
    }
  };
  const rows = question.options.map((option, index) => {
    const on = picks.picked.includes(option.label);
    const key = optionLetter(index);
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
            className={box}
          />
        </span>
        <LetterKey letter={key} on={on} />
        {words}
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
        <LetterKey letter={key} on={on} />
        {words}
      </button>
    );
  });
  const field = (
    <input
      aria-label={`${question.prompt}: your own answer`}
      placeholder="Your answer"
      // Only when the person opens it: a card turned back to keeps its first control focused.
      autoFocus={focusOwn}
      disabled={disabled}
      value={picks.other}
      onChange={(event) => props.onDraft({ ...picks, other: event.target.value })}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !picks.other) {
          event.preventDefault();
          closeOwn();
          return;
        }
        props.enter(event);
      }}
      aria-invalid={props.invalid}
      className={ownField}
    />
  );
  const ownKey = ownDigit === undefined ? undefined : optionLetter(ownDigit - 1);
  const own = many ? (
    <div className={cn(optionRow, "items-center", ownOpen && optionChosen)}>
      <span className="flex h-5 shrink-0 items-center">
        <Checkbox
          aria-label="Something else"
          checked={ownOpen}
          disabled={disabled}
          onCheckedChange={(on) => (on ? openOwn() : closeOwn())}
          className={box}
        />
      </span>
      <LetterKey letter={ownKey} on={ownOpen} />
      {ownOpen ? (
        field
      ) : (
        <button type="button" disabled={disabled} onClick={openOwn} className="flex-1 text-left">
          Something else…
        </button>
      )}
    </div>
  ) : ownOpen ? (
    <div className={cn(optionRow, "items-center", optionChosen)}>
      <LetterKey letter={ownKey} on />
      {field}
    </div>
  ) : (
    <button
      type="button"
      role="radio"
      aria-checked={false}
      aria-label="Something else"
      disabled={disabled}
      onClick={openOwn}
      className={optionRow}
    >
      <LetterKey letter={ownKey} />
      <span className="text-muted-foreground">Something else…</span>
    </button>
  );
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
          {own}
        </div>
      ) : (
        <div
          role="radiogroup"
          aria-label={question.prompt}
          onKeyDown={digit}
          className="flex flex-col gap-2"
        >
          {rows}
          {own}
        </div>
      )}
      {many && (
        <p className="text-xs leading-4 text-subtle-foreground tabular-nums">
          {`${spadePickCount(question, picks)} picked`}
        </p>
      )}
    </div>
  );
}
