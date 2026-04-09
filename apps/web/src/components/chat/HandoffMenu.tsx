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
}) {
  if (props.disabled) {
    return <MenuItem disabled>Handoff unavailable right now.</MenuItem>;
  }

  if (props.providers.length === 0) {
    return <MenuItem disabled>No other providers available.</MenuItem>;
  }

  return (
    <>
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Handoff to</div>
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
  disabled?: boolean;
  showLabel?: boolean;
  triggerClassName?: string;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  onSelect: (provider: ProviderKind, mode: ThreadHandoffMode) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            className={
              props.triggerClassName ??
              "shrink-0 whitespace-nowrap px-2 text-muted-foreground/60 transition-colors duration-150 hover:text-foreground/70"
            }
            disabled={props.disabled}
            aria-label="Handoff to another provider"
          />
        }
      >
        <ArrowLeftRightIcon className="size-4" />
        {props.showLabel === false ? null : <span className="sr-only sm:not-sr-only">Handoff</span>}
      </MenuTrigger>
      <MenuPopup align="start">
        <HandoffMenuEntries
          providers={props.providers}
          disabled={props.disabled ?? false}
          onSelect={props.onSelect}
        />
      </MenuPopup>
    </Menu>
  );
});
