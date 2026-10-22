import { useRef, useState, type ReactNode } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Input } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";

export interface Choice {
  value: string;
  label: string;
  /** A second, quieter line: a label's description, a milestone's due date. */
  hint?: string | undefined;
  /** A mark before the label: a label's colour. */
  mark?: ReactNode;
}

/**
 * A filterable list in a popover: one pick closes it; several stay open to pick more. The
 * trigger is the current value as quiet text with a caret, as the page's other choices are.
 */
export function ChoicePicker(props: {
  label: string;
  choices: readonly Choice[];
  picked: readonly string[];
  multiple?: boolean;
  /** What the trigger says: the picked values, or what to do when none is. */
  trigger: ReactNode;
  disabled?: boolean;
  /** Mono text for branch names. */
  mono?: boolean;
  onChange(picked: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const needle = filter.trim().toLowerCase();
  const shown = props.choices
    .filter((choice) => !needle || choice.label.toLowerCase().includes(needle))
    .slice(0, 200);
  const pick = (value: string) => {
    if (!props.multiple) {
      props.onChange([value]);
      setOpen(false);
      return;
    }
    props.onChange(
      props.picked.includes(value)
        ? props.picked.filter((each) => each !== value)
        : [...props.picked, value],
    );
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFilter("");
      }}
    >
      <PopoverTrigger
        disabled={props.disabled}
        aria-label={props.label}
        className={cn(
          "inline-flex h-7 max-w-full min-w-0 items-center gap-1 rounded-md px-1.5 text-ui text-foreground focus-ring hover:bg-hover aria-expanded:bg-active disabled:opacity-50",
          props.mono && "font-mono text-xs",
        )}
      >
        <span className="min-w-0 truncate">{props.trigger}</span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-faint-foreground" />
      </PopoverTrigger>
      <PopoverContent aria-label={props.label} className="w-72 p-1" initialFocus={field}>
        <Input
          ref={field}
          aria-label={`Filter ${props.label.toLowerCase()}`}
          placeholder="Filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            const first = shown[0];
            if (event.key === "Enter" && first) {
              event.preventDefault();
              pick(first.value);
            }
          }}
          className="mb-1"
        />
        <ul role="listbox" aria-multiselectable={props.multiple} className="max-h-72 overflow-y-auto">
          {shown.map((choice) => {
            const selected = props.picked.includes(choice.value);
            return (
              <li key={choice.value} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => pick(choice.value)}
                  className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-ui focus-ring-inset hover:bg-hover"
                >
                  <CheckIcon
                    aria-hidden
                    size={14}
                    className={cn("shrink-0", selected ? "text-foreground" : "invisible")}
                  />
                  {choice.mark}
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate", props.mono && "font-mono text-xs")}>
                      {choice.label}
                    </span>
                    {choice.hint && (
                      <span className="block truncate text-xs text-subtle-foreground">
                        {choice.hint}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          {!shown.length && (
            <li className="px-2 py-1.5 text-ui text-muted-foreground">Nothing matches.</li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
