import type { ReactNode } from "react";
import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { cn } from "@/lib/cn.ts";

/** One choice of a few, each with a line saying what it means. */
export interface SpadeChoice<T extends string> {
  value: T;
  label: string;
  description: string;
  icon?: ReactNode;
}

/** A short list of choices, one picked, each its own selectable card with label and description. */
export function SpadeChoices<T extends string>(props: {
  label: string;
  value: T;
  choices: readonly SpadeChoice<T>[];
  onChange(value: T): void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      onKeyDown={onRadioKeys}
      className="grid w-full gap-2"
    >
      {props.choices.map((choice) => {
        const selected = choice.value === props.value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => props.onChange(choice.value)}
            className={cn(
              "flex w-full cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors duration-(--motion-fast) focus-ring-inset",
              selected
                ? "border-foreground/75 bg-accent/50 ring-1 ring-inset ring-foreground/75"
                : "border-border-soft hover:border-border hover:bg-accent/25",
            )}
          >
            {choice.icon && (
              <span
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center transition-colors duration-(--motion-fast)",
                  selected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {choice.icon}
              </span>
            )}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-ui font-medium text-foreground">{choice.label}</span>
              <span className="text-xs text-muted-foreground">{choice.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
