import { GripVerticalIcon, XIcon } from "lucide-react";

import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { useSidebarThreadSummaryById } from "../../storeSelectors";
import { cn } from "~/lib/utils";
import type { ThreadBoardPaneContentProps } from "./threadBoardTypes";

export function ThreadBoardPaneContent(props: ThreadBoardPaneContentProps) {
  const { chatState, pane, visualState } = props;
  const sidebarThread = useSidebarThreadSummaryById(pane.threadId);
  const paneTitle = sidebarThread?.title ?? "thread";
  const className = cn(
    "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-[opacity,filter] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
    visualState.isDimmedPane
      ? "opacity-92 saturate-[0.92] brightness-[1] contrast-[1]"
      : "opacity-100",
  );

  if (visualState.deferContent) {
    return <div aria-hidden="true" className={className} />;
  }

  return (
    <div className={className}>
      <ChatView
        activeInBoard={visualState.isFocusedPane}
        connectionUrl={pane.connectionUrl}
        paneControls={
          !visualState.isSinglePane ? (
            <>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                draggable
                className="no-drag-region size-7 cursor-pointer text-muted-foreground/55 opacity-80 transition-[background-color,color,opacity,transform] duration-150 hover:-translate-y-px hover:text-foreground hover:opacity-100 active:cursor-grabbing active:translate-y-0"
                onClick={(event) => {
                  event.stopPropagation();
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onDragStart={(event) => {
                  props.onPaneDragStart?.(pane, paneTitle, event);
                }}
                onDragEnd={props.onPaneDragEnd}
                aria-label={`Move ${paneTitle}`}
              >
                <GripVerticalIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="no-drag-region size-7 text-muted-foreground/55 opacity-80 transition-[background-color,color,opacity,transform] duration-150 hover:-translate-y-px hover:text-foreground hover:opacity-100 active:translate-y-0"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onClosePane(pane);
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                aria-label={`Close ${paneTitle}`}
              >
                <XIcon className="size-3.5" />
              </Button>
            </>
          ) : null
        }
        threadId={pane.threadId}
        shortcutsEnabled={chatState.shortcutsEnabled}
        showSidebarTrigger={chatState.showSidebarTrigger}
        splitPane={chatState.splitPane ?? true}
        visibleBoardThreadIds={chatState.visibleBoardThreadIds}
      />
    </div>
  );
}
