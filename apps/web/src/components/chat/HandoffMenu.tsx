import { PROVIDER_DISPLAY_NAMES, type ProviderKind, type ThreadHandoffMode } from "@ace/contracts";
import { ArrowRightLeftIcon } from "lucide-react";
import { memo } from "react";
import type { VariantProps } from "class-variance-authority";
import { Button } from "../ui/button";
import { buttonVariants } from "../ui/buttonVariants";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { APP_COMPOSER_CONTROL_CLASS_NAME } from "~/lib/appChrome";
import { cn } from "~/lib/utils";
import { PROVIDER_ICON_BY_PROVIDER, providerIconClassName } from "./providerIcons";

function formatProviderLabel(provider: ProviderKind): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

const HandoffMenuEntries = memo(function HandoffMenuEntries(props: {
  providers: ReadonlyArray<ProviderKind>;
  disabled?: boolean;
  onSelect: (provider: ProviderKind, mode: ThreadHandoffMode) => void;
  /** Hide the default “Handoff to” row (e.g. when a parent already shows a title). */
  omitLeadingLabel?: boolean;
}) {
  if (props.disabled) {
    return <MenuItem disabled>Handoff unavailable right now.</MenuItem>;
  }

  if (props.providers.length === 0) {
    return <MenuItem disabled>No other providers available.</MenuItem>;
  }

  return (
    <>
      {props.omitLeadingLabel ? null : (
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Handoff to</div>
      )}
      {props.providers.map((provider) => {
        const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[provider];
        return (
          <MenuItem
            key={provider}
            className="min-h-7 gap-2 px-2 text-sm text-foreground/90"
            onClick={() => props.onSelect(provider, "best")}
          >
            <ProviderIcon
              aria-hidden="true"
              className={cn("size-4", providerIconClassName(provider, "text-muted-foreground"))}
            />
            <span>{formatProviderLabel(provider)}</span>
          </MenuItem>
        );
      })}
    </>
  );
});

export const HandoffMenuButton = memo(function HandoffMenuButton(props: {
  providers: ReadonlyArray<ProviderKind>;
  /** Disables the trigger (e.g. composer disabled). */
  disabled?: boolean;
  /**
   * Disables handoff actions inside the menu while keeping the menu openable
   * (e.g. handoff in flight or no target providers).
   */
  entriesDisabled?: boolean;
  /** When true, show a visible “Handoff” label next to the icon (sm+). Default: icon only. */
  showLabel?: boolean;
  triggerClassName?: string;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  onSelect: (provider: ProviderKind, mode: ThreadHandoffMode) => void;
}) {
  const showLabel = props.showLabel === true;
  const entriesDisabled =
    props.entriesDisabled !== undefined ? props.entriesDisabled : (props.disabled ?? false);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size={showLabel ? "sm" : "icon-xs"}
            variant={props.triggerVariant ?? "ghost"}
            className={
              props.triggerClassName ??
              (showLabel
                ? cn(APP_COMPOSER_CONTROL_CLASS_NAME, "whitespace-nowrap px-2")
                : APP_COMPOSER_CONTROL_CLASS_NAME)
            }
            disabled={props.disabled}
            aria-label="Handoff to another provider"
          />
        }
      >
        <ArrowRightLeftIcon className="size-3.5" />
        {showLabel ? <span className="sr-only sm:not-sr-only">Handoff</span> : null}
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-40" listClassName="p-1">
        <HandoffMenuEntries
          providers={props.providers}
          disabled={entriesDisabled}
          onSelect={props.onSelect}
        />
      </MenuPopup>
    </Menu>
  );
});
