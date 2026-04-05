import { MessageCircleIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
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
      className="grid grid-cols-2 items-stretch rounded-[1rem] border border-border/70 bg-background/92 p-1 shadow-xs/5 supports-[backdrop-filter]:bg-background/78 supports-[backdrop-filter]:backdrop-blur-md"
      value={[props.mode]}
      onValueChange={(value) => {
        const nextMode = value[0];
        if ((nextMode === "chat" || nextMode === "editor") && nextMode !== props.mode) {
          props.onModeChange(nextMode);
        }
      }}
    >
      {WORKSPACE_MODES.map(({ value, label, Icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          variant="default"
          size="sm"
          className="group/mode h-auto min-w-[6.5rem] rounded-[0.85rem] border-transparent px-3 py-1.5 text-left text-foreground/80 shadow-none transition-[background-color,color,box-shadow] hover:bg-accent/50 data-[pressed]:bg-accent/80 data-[pressed]:text-foreground data-[pressed]:shadow-xs/5"
        >
          <span className="flex items-center gap-2">
            <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-foreground/5 text-muted-foreground transition-colors group-data-[pressed]/mode:bg-primary/12 group-data-[pressed]/mode:text-primary">
              <Icon className="size-3.5" />
            </span>
            <span className="text-[11px] font-semibold tracking-[0.18em] uppercase">{label}</span>
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
});
