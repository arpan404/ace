import { ProviderInteractionMode } from "@ace/contracts";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";

export function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  interactionModeShortcutLabel: string | null;
  interactionModeDisabledReason?: string | null;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Menu open={menuOpen} onOpenChange={setMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 rounded-full px-2.5 text-muted-foreground/68 hover:bg-foreground/[0.05] hover:text-foreground/88"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
        <MenuRadioGroup
          value={props.interactionMode}
          onValueChange={(value) => {
            if (!value || value === props.interactionMode) return;
            if (
              value === "plan" &&
              props.interactionModeDisabledReason &&
              props.interactionMode !== "plan"
            ) {
              return;
            }
            props.onToggleInteractionMode();
          }}
        >
          <MenuRadioItem value="default">
            Agent
            {props.interactionModeShortcutLabel ? (
              <MenuShortcut>{props.interactionModeShortcutLabel}</MenuShortcut>
            ) : null}
          </MenuRadioItem>
          <MenuRadioItem
            value="plan"
            disabled={Boolean(
              props.interactionModeDisabledReason && props.interactionMode !== "plan",
            )}
          >
            Plan
          </MenuRadioItem>
        </MenuRadioGroup>
        {props.interactionModeDisabledReason ? (
          <div className="px-2 pb-1.5 pt-1 text-muted-foreground/75 text-xs">
            {props.interactionModeDisabledReason}
          </div>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
