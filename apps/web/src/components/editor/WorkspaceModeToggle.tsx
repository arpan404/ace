import { MessageCircleIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
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
    <div
      role="radiogroup"
      aria-label="Switch workspace mode"
      className="relative grid shrink-0 grid-cols-2 items-center rounded-full border border-border/30 bg-background/70 p-[3px] shadow-sm shadow-black/5 supports-[backdrop-filter]:bg-background/45 supports-[backdrop-filter]:backdrop-blur-xl dark:shadow-black/20"
    >
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-[3px] w-[calc(50%-1.5px)] rounded-full border border-border/25 bg-foreground/[0.05] shadow-sm transition-[left] duration-200 ease-[cubic-bezier(0.25,0.1,0.25,1)]",
          props.mode === "chat" ? "left-[3px]" : "left-[calc(50%+1.5px)]",
        )}
      />
      {WORKSPACE_MODES.map(({ value, label, Icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger
            render={
              <button
                type="button"
                role="radio"
                aria-checked={props.mode === value}
                aria-label={label}
                className={cn(
                  "relative z-10 inline-flex min-w-0 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium tracking-tight transition-colors duration-150 sm:text-xs",
                  props.mode === value
                    ? "text-foreground"
                    : "text-muted-foreground/60 hover:text-foreground/80",
                )}
                onClick={() => {
                  if (value !== props.mode) {
                    props.onModeChange(value);
                  }
                }}
              >
                <Icon className="size-3.25 sm:size-3.5" />
                <span className="truncate">{label}</span>
              </button>
            }
          />
          <TooltipPopup side="bottom">{label}</TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
});
