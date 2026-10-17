import { stepHighlight } from "@ace/ui-core";
import { compareRanked, rankCommand } from "@ace/ui-core/command-rank";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import {
  CommandOption,
  CommandStepList,
  CommandStepRow,
  commandStepField,
  stepFieldKey,
} from "./command-step.tsx";

export interface CommandChoice {
  id: string;
  label: string;
  icon: IconGlyph;
  /** Muted text after the label; also searched. */
  detail?: string | undefined;
  /** Shown at the right (a machine's status). */
  aside?: ReactNode;
  disabled?: boolean;
}

/**
 * A palette step that is one short list to choose from (Add project's sources, a machine, a
 * project): the field narrows it, ↑ ↓ move, Enter or a click chooses. The first row is
 * highlighted from the start.
 */
export function CommandChoices(props: {
  fieldLabel: string;
  listLabel: string;
  placeholder: string;
  choices: readonly CommandChoice[];
  onChoose(choice: CommandChoice): void;
  onBack: (() => void) | undefined;
  empty: string;
  trailing?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [active, setActive] = useState<number | undefined>(0);
  const listId = useId();
  const rows = useMemo(
    () =>
      props.choices
        .flatMap((choice) => {
          const score = rankCommand(text, { label: choice.label, fields: [choice.detail] });
          return score === null ? [] : [{ choice, score }];
        })
        .toSorted(compareRanked)
        .map((row) => row.choice),
    [props.choices, text],
  );
  const current = active === undefined ? undefined : Math.min(active, rows.length - 1);
  const highlighted = current === undefined || current < 0 ? undefined : rows[current];
  useEffect(() => {
    if (current !== undefined)
      document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, listId]);
  const choose = (choice: CommandChoice | undefined) => {
    if (choice && !choice.disabled) props.onChoose(choice);
  };
  return (
    <>
      <CommandStepRow onBack={props.onBack}>
        <input
          role="combobox"
          aria-label={props.fieldLabel}
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={highlighted ? `${listId}-${current}` : undefined}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- A palette step opens to its field.
          autoFocus
          value={text}
          placeholder={props.placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (stepFieldKey(event, { text, onBack: props.onBack, onClear: () => setText("") }))
              return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp")
              setActive(stepHighlight(current, event.key === "ArrowDown" ? 1 : -1, rows.length));
            else if (event.key === "Enter") choose(highlighted);
            else return;
            event.preventDefault();
          }}
          className={commandStepField}
        />
        {props.trailing}
      </CommandStepRow>
      <CommandStepList id={listId} label={props.listLabel}>
        {rows.map((choice, at) => (
          <CommandOption
            key={choice.id}
            id={`${listId}-${at}`}
            active={at === current}
            label={choice.label}
            disabled={choice.disabled}
            onPoint={() => setActive(at)}
            onPick={() => choose(choice)}
          >
            <Icon icon={choice.icon} />
            <span className="min-w-0 flex-1 truncate">
              {choice.label}
              {choice.detail && (
                <span className="ml-1.5 text-sm text-muted-foreground">{choice.detail}</span>
              )}
            </span>
            {choice.aside}
          </CommandOption>
        ))}
        {rows.length === 0 && (
          <div role="status" className="py-8 text-center text-ui text-muted-foreground">
            {props.empty}
          </div>
        )}
      </CommandStepList>
    </>
  );
}
