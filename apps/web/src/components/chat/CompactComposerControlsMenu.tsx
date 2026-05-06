import { ProviderInteractionMode, RuntimeMode } from "@ace/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
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

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  interactionModeShortcutLabel: string | null;
  interactionModeDisabledReason?: string | null;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground hover:text-foreground"
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
});
