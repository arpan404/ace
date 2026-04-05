import { MessageCircleIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";

const WORKSPACE_MODES: ReadonlyArray<{
  value: ThreadWorkspaceMode;
  label: string;
  Icon: typeof MessageCircleIcon;
}> = [
  { value: "chat", label: "Chat", Icon: MessageCircleIcon },
  { value: "editor", label: "Editor", Icon: SquarePenIcon },
];

export const WorkspaceModeToggle = memo(function WorkspaceModeToggle(props: {
  mode: ThreadWorkspaceMode;
  onModeChange: (mode: ThreadWorkspaceMode) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Switch workspace mode"
      className="flex items-center gap-1 rounded-full border border-border/70 bg-background/92 p-1 shadow-xs/5 supports-[backdrop-filter]:bg-background/78 supports-[backdrop-filter]:backdrop-blur-md"
      value={[props.mode]}
      onValueChange={(value) => {
        const nextMode = value[0];
        if ((nextMode === "chat" || nextMode === "editor") && nextMode !== props.mode) {
          props.onModeChange(nextMode);
        }
      }}
    >
      {WORKSPACE_MODES.map(({ value, label, Icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger
            render={
              <ToggleGroupItem
                value={value}
                variant="default"
                size="sm"
                className="group/mode size-6.5 rounded-full border-transparent p-0 text-muted-foreground shadow-none transition-colors hover:bg-accent/50 data-[pressed]:bg-primary/12 data-[pressed]:text-primary data-[pressed]:shadow-none"
              >
                <Icon className="size-3.5" />
              </ToggleGroupItem>
            }
          />
          <TooltipPopup side="bottom">{label}</TooltipPopup>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
});
