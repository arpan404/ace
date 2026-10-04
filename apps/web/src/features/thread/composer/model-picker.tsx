import { accountTag, providerNames, type EffortControl, type ModelChoice } from "@ace/ui-core";
import { Suspense } from "react";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { ModelChipLabel } from "@/features/models/index.ts";
import { cn } from "@/lib/cn.ts";
import { useComposerCompact } from "./composer-compact.ts";
import { chipControl } from "./composer-styles.ts";
import { DeferredModelMenu, MenuPending } from "./deferred-menus.tsx";

/**
 * The thread's model, account and effort in one footer chip ("◆ Opus 4.1 personal high ▾"),
 * capped so a long name truncates instead of crowding the other controls. The menu lists models
 * by provider with each account's usage, then the effort levels the provider lets a running
 * thread change.
 */
export function ModelPicker(props: {
  choices: readonly ModelChoice[];
  value: ModelChoice | undefined;
  effort: EffortControl;
  onChange(choice: ModelChoice): void;
  onEffort(effort: string): void;
}) {
  const { value, effort } = props;
  const compact = useComposerCompact();
  const account = value?.account ? accountTag(value.account) : undefined;
  const name = value
    ? [value.model, account, effort.current && `${effort.current} effort`]
        .filter(Boolean)
        .join(", ")
    : undefined;
  return (
    <Menu>
      <Tip
        label={
          value
            ? [providerNames[value.provider], value.model, account, effort.current]
                .filter(Boolean)
                .join(" · ")
            : "Choose a model"
        }
        side="top"
      >
        <MenuTrigger
          aria-label={name ? `Model: ${name}` : "Choose a model"}
          className={cn(chipControl, "max-w-64")}
        >
          {value ? (
            <ModelChipLabel
              provider={value.provider}
              model={value.model}
              account={account}
              effort={effort.current}
              compact={compact}
            />
          ) : (
            <span className="truncate">Model</span>
          )}
        </MenuTrigger>
      </Tip>
      <MenuContent side="top" align="start" className="max-h-[60vh] w-[320px] overflow-y-auto">
        <Suspense fallback={<MenuPending />}>
          <DeferredModelMenu.Component
            choices={props.choices}
            value={value}
            effort={effort}
            onChange={props.onChange}
            onEffort={props.onEffort}
          />
        </Suspense>
      </MenuContent>
    </Menu>
  );
}
