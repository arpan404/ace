import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";

/** One choice of a few, each with a line saying what it means. */
export interface SpadeChoice<T extends string> {
  value: T;
  label: string;
  description: string;
}

/** A short list of choices, one picked, each its own label and line under it. */
export function SpadeChoices<T extends string>(props: {
  label: string;
  value: T;
  choices: readonly SpadeChoice<T>[];
  onChange(value: T): void;
}) {
  return (
    <RadioGroup
      aria-label={props.label}
      value={props.value}
      onValueChange={(value) => {
        const picked = props.choices.find((choice) => choice.value === value);
        if (picked) props.onChange(picked.value);
      }}
      className="gap-3"
    >
      {props.choices.map((choice) => (
        <label key={choice.value} className="flex cursor-pointer items-start gap-3">
          <RadioGroupItem value={choice.value} className="mt-0.5" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-ui font-medium">{choice.label}</span>
            <span className="text-xs text-muted-foreground">{choice.description}</span>
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}
