import { spadeAccessChoices, type SpadeAccess } from "@ace/ui-core/spade-chat";
import { useId, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group.tsx";

/**
 * How much a bot may do without asking: Ask, Auto-review or Full access, each with its one plain
 * line. Full access is asked about once before it is chosen; the others take at once.
 */
export function AccessChoice(props: {
  /** The bot's name, for the confirmation. */
  name: string;
  value: SpadeAccess;
  onChange(access: SpadeAccess): void;
  disabled?: boolean;
  /** A section above already says "Access": the choice's own heading is for screen readers. */
  headed?: boolean;
}) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const label = `${id}-label`;
  return (
    <div className="flex flex-col gap-1.5">
      <span id={label} className={props.headed ? "sr-only" : "w-fit text-ui font-medium"}>
        Access
      </span>
      <RadioGroup
        aria-labelledby={label}
        value={props.value}
        disabled={props.disabled}
        onValueChange={(next: unknown) => {
          const picked = spadeAccessChoices.find((choice) => choice.value === next);
          if (!picked || picked.value === props.value) return;
          if (picked.value === "full_access") setConfirming(true);
          else props.onChange(picked.value);
        }}
        className="gap-2.5"
      >
        {spadeAccessChoices.map((choice) => (
          <label key={choice.value} className="flex cursor-pointer items-start gap-2.5">
            <RadioGroupItem
              value={choice.value}
              aria-labelledby={`${id}-${choice.value}-name`}
              aria-describedby={`${id}-${choice.value}-line`}
              className="mt-0.5"
            />
            <span className="flex min-w-0 flex-col">
              <span id={`${id}-${choice.value}-name`} className="text-ui text-foreground">
                {choice.label}
              </span>
              <span id={`${id}-${choice.value}-line`} className="text-xs text-muted-foreground">
                {choice.line}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
      <ConfirmDialog
        confirming={
          confirming
            ? {
                title: `Give ${props.name} full access?`,
                body: "It will never ask before it acts, even to pay, send as you, publish or delete. You keep Stop, spend limits and the activity log.",
                confirm: "Give full access",
                run: () => props.onChange("full_access"),
              }
            : undefined
        }
        onDone={() => setConfirming(false)}
      />
    </div>
  );
}
