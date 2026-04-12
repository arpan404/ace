import { PROVIDER_DISPLAY_NAMES, type ProviderKind, type ThreadHandoffMode } from "@ace/contracts";
import { ArrowLeftRightIcon } from "lucide-react";
import { memo } from "react";
import type { VariantProps } from "class-variance-authority";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";

function formatProviderLabel(provider: ProviderKind): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

export const HandoffMenuEntries = memo(function HandoffMenuEntries(props: {
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
      {props.providers.map((provider) => (
        <MenuSub key={provider}>
          <MenuSubTrigger>{formatProviderLabel(provider)}</MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem onClick={() => props.onSelect(provider, "transcript")}>
              Full transcript
            </MenuItem>
            <MenuItem onClick={() => props.onSelect(provider, "compact")}>Compact summary</MenuItem>
          </MenuSubPopup>
        </MenuSub>
      ))}
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
                ? "shrink-0 whitespace-nowrap px-2 text-muted-foreground/60 transition-colors duration-150 hover:text-foreground/70"
                : "shrink-0 text-muted-foreground/60 transition-colors duration-150 hover:text-foreground/70")
            }
            disabled={props.disabled}
            aria-label="Handoff to another provider"
          />
        }
      >
        <ArrowLeftRightIcon className="size-4" />
        {showLabel ? <span className="sr-only sm:not-sr-only">Handoff</span> : null}
      </MenuTrigger>
      <MenuPopup align="start">
        <HandoffMenuEntries
          providers={props.providers}
          disabled={entriesDisabled}
          onSelect={props.onSelect}
        />
      </MenuPopup>
    </Menu>
  );
});
