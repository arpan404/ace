import { ArrowLeftIcon } from "@phosphor-icons/react";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { commandField, CommandSearchRow } from "./command.tsx";
import { IconButton } from "./icon-button.tsx";
import { KeyHintList, type KeyHint } from "./key-hints.tsx";
import { sectionRule } from "./rules.ts";

/*
 * A palette step (Add project's sources, its Local folder, New thread in…): the palette's own
 * sheet with a Back button in place of the magnifier, a field, a list the field steps through
 * with ↑ ↓, and an optional footer with the step's action. Backspace in an empty field goes back
 * one step; Esc clears the field, then closes.
 */

/** The step's top row: Back, its field, anything beside it, and the esc chip. */
function CommandStepRow(props: {
  onBack: (() => void) | undefined;
  children: ReactNode;
  closeLabel?: string;
}) {
  return (
    <CommandSearchRow
      closeLabel={props.closeLabel ?? "Close command palette"}
      leading={
        props.onBack ? (
          <IconButton icon={ArrowLeftIcon} label="Back" size="sm" onClick={props.onBack} />
        ) : undefined
      }
    >
      {props.children}
    </CommandSearchRow>
  );
}

/** The field's look in the step's top row. */
const commandStepField = commandField;

/**
 * The step field's own keys: Backspace in an empty field goes back, Esc with text clears it
 * (a second Esc closes the palette). True when the key was taken.
 */
function stepFieldKey(
  event: KeyboardEvent<HTMLInputElement>,
  options: { text: string; onBack: (() => void) | undefined; onClear(): void },
): boolean {
  if (event.key === "Backspace" && options.text === "" && options.onBack) {
    event.preventDefault();
    options.onBack();
    return true;
  }
  if (event.key === "Escape" && options.text !== "") {
    event.preventDefault();
    event.stopPropagation();
    options.onClear();
    return true;
  }
  return false;
}

/** The scrolling list under the field. */
function CommandStepList(props: {
  id: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      id={props.id}
      role="listbox"
      aria-label={props.label}
      className={cn("min-h-0 flex-1 scroll-py-1 overflow-y-auto p-1", props.className)}
    >
      {props.children}
    </div>
  );
}

/** One row of a step's list, pointed at by the field (`aria-activedescendant`). */
function CommandOption(props: {
  id: string;
  active: boolean;
  onPoint(): void;
  onPick(): void;
  children: ReactNode;
  label?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keys pick through the field's aria-activedescendant
    <div
      id={props.id}
      role="option"
      aria-selected={props.active}
      aria-label={props.label}
      aria-disabled={props.disabled ? true : undefined}
      data-highlighted={props.active ? "" : undefined}
      tabIndex={-1}
      onPointerMove={props.active ? undefined : props.onPoint}
      // The field keeps focus: picking with the mouse never moves it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.disabled ? undefined : props.onPick}
      className={cn(
        "flex h-9 cursor-default items-center gap-[9px] rounded-md px-2.5 text-ui text-foreground select-none data-highlighted:bg-accent aria-disabled:opacity-50 pointer-coarse:h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

/** A small section label inside a step's list. */
function CommandStepLabel(props: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-subtle-foreground">
      {props.children}
    </div>
  );
}

/** The step's footer: its key hints and what's chosen on the left, its actions on the right. */
function CommandStepFooter(props: {
  children: ReactNode;
  note?: ReactNode;
  hints?: readonly KeyHint[];
}) {
  return (
    <div className={cn("flex min-h-12 shrink-0 items-center gap-2 px-3 py-2", sectionRule)}>
      {props.hints && <KeyHintList hints={props.hints} className="shrink" />}
      <div className="min-w-0 flex-1 truncate font-mono text-xs text-subtle-foreground">
        {props.note}
      </div>
      {props.children}
    </div>
  );
}

export {
  CommandOption,
  CommandStepFooter,
  CommandStepLabel,
  CommandStepList,
  CommandStepRow,
  commandStepField,
  stepFieldKey,
};
