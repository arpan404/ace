import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ProviderKind } from "@ace/protocol";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/cn.ts";
import { Fragment } from "react";
import { Menu, MenuContent, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu.tsx";
import { menuItem } from "@/components/ui/menu-styles.ts";
import { providerNames } from "@ace/ui-core";
import type { ModelChoice } from "../sources/model-source.ts";
import { useThreadSources } from "../sources/index.ts";

/** The model catalog with each account's usage, grouped by provider. */
export function useModelChoices(): readonly ModelChoice[] {
  const sources = useThreadSources();
  return (
    useQuery({ queryKey: ["models", "choices"], queryFn: () => sources.models.choices() }).data ??
    []
  );
}

/** First usable choice for a provider: what a thread starts with until the person picks. */
export function defaultChoice(
  choices: readonly ModelChoice[],
  provider: ProviderKind | undefined,
): ModelChoice | undefined {
  return (
    choices.find((choice) => choice.provider === provider && !choice.resetsAt) ??
    choices.find((choice) => !choice.resetsAt)
  );
}

/** "Opus 4.6 personal ▾": model and account, with usage meters where the choice is made. */
export function ModelPicker(props: {
  choices: readonly ModelChoice[];
  value: ModelChoice | undefined;
  onChange(choice: ModelChoice): void;
}) {
  const providers = [...new Set(props.choices.map((choice) => choice.provider))];
  return (
    <Menu>
      <MenuTrigger
        aria-label={
          props.value ? `Model: ${props.value.model}, ${props.value.account}` : "Choose a model"
        }
        className="inline-flex h-[30px] items-center gap-[5px] rounded-[9px] px-[9px] text-sm font-medium text-muted-foreground transition-colors duration-150 outline-none hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
      >
        {props.value ? (
          <>
            {props.value.model}
            <span className="font-normal text-subtle-foreground">{props.value.account}</span>
          </>
        ) : (
          "Model"
        )}
        <CaretDownIcon aria-hidden size={14} />
      </MenuTrigger>
      <MenuContent side="top" align="end" className="w-[300px]">
        <MenuPrimitive.RadioGroup
          value={props.value?.id ?? ""}
          onValueChange={(id: string) => {
            const choice = props.choices.find((candidate) => candidate.id === id);
            if (choice) props.onChange(choice);
          }}
        >
          {providers.map((provider, index) => (
            <Fragment key={provider}>
              {index > 0 && <MenuSeparator />}
              <MenuPrimitive.Group>
                <MenuLabel>{providerNames[provider]}</MenuLabel>
                {props.choices
                  .filter((choice) => choice.provider === provider)
                  .map((choice) => (
                    <ChoiceItem key={choice.id} choice={choice} />
                  ))}
              </MenuPrimitive.Group>
            </Fragment>
          ))}
        </MenuPrimitive.RadioGroup>
      </MenuContent>
    </Menu>
  );
}

function ChoiceItem(props: { choice: ModelChoice }) {
  const { choice } = props;
  const exhausted = !!choice.resetsAt;
  return (
    <MenuPrimitive.RadioItem
      value={choice.id}
      disabled={exhausted}
      aria-label={`${choice.model} · ${choice.account}`}
      className={cn(menuItem, "h-auto items-start py-[7px]")}
    >
      <span className="mt-px grid w-4 shrink-0 place-items-center">
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon aria-hidden size={14} />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      <span className="flex min-w-0 flex-col">
        <span>
          {choice.model} · {choice.account}
        </span>
        <span className="mt-px text-xs text-subtle-foreground">
          {exhausted ? `Limit reached · resets ${choice.resetsAt}` : choice.note}
        </span>
        {choice.used !== undefined && (
          <span
            role="meter"
            aria-label={`${choice.account} usage`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(choice.used * 100)}
            className="mt-1.5 h-[3px] w-[150px] overflow-hidden rounded-[2px] bg-secondary"
          >
            <span
              className={cn(
                "block h-full rounded-[2px]",
                exhausted ? "bg-status-failed" : "bg-muted-foreground",
              )}
              style={{ width: `${Math.min(100, choice.used * 100)}%` }}
            />
          </span>
        )}
      </span>
    </MenuPrimitive.RadioItem>
  );
}
