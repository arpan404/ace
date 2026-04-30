import { Columns2Icon, MessageCircleIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";

const WORKSPACE_MODE_METADATA: Record<
  ThreadWorkspaceMode,
  {
    label: string;
    Icon: typeof MessageCircleIcon;
  }
> = {
  chat: { label: "Chat", Icon: MessageCircleIcon },
  split: { label: "Split", Icon: Columns2Icon },
  editor: { label: "Editor", Icon: SquarePenIcon },
};

const DEFAULT_WORKSPACE_MODES: ReadonlyArray<ThreadWorkspaceMode> = ["chat", "split", "editor"];

export const WorkspaceModeToggle = memo(function WorkspaceModeToggle(props: {
  mode: ThreadWorkspaceMode;
  modes?: ReadonlyArray<ThreadWorkspaceMode>;
  onModeChange: (mode: ThreadWorkspaceMode) => void;
  className?: string;
}) {
  const visibleModes = props.modes ?? DEFAULT_WORKSPACE_MODES;
  const activeModeIndex = Math.max(
    0,
    visibleModes.findIndex((mode) => mode === props.mode),
  );

  return (
    <div
      role="radiogroup"
      aria-label="Switch workspace mode"
      className={cn(
        "relative grid shrink-0 items-center rounded-full border border-border bg-muted p-[3px]  ",
        props.className,
      )}
      style={{ gridTemplateColumns: `repeat(${visibleModes.length}, minmax(0, 1fr))` }}
    >
      <div
        aria-hidden
        className="absolute inset-y-[3px] left-[3px] rounded-full border border-border bg-card  transition-transform duration-[250ms] ease-[var(--transition-timing)] will-change-transform"
        style={{
          width: `calc((100% - 6px) / ${visibleModes.length})`,
          transform: `translateX(${activeModeIndex * 100}%)`,
        }}
      />
      {visibleModes.map((value) => {
        const { label, Icon } = WORKSPACE_MODE_METADATA[value];
        return (
          <Tooltip key={value}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={props.mode === value}
                  aria-label={label}
                  className={cn(
                    "relative z-10 inline-flex min-w-0 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium tracking-tight transition-[color,transform] duration-150 sm:text-xs [&_svg]:transition-transform [&_svg]:duration-200",
                    props.mode === value
                      ? "text-foreground [&_svg]:scale-105"
                      : "text-muted-foreground hover:text-foreground hover:[&_svg]:scale-105",
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
        );
      })}
    </div>
  );
});
