import type { ThreadId } from "@ace/contracts";
import { AnimatePresence } from "motion/react";
import { useSyncExternalStore, type DragEvent as ReactDragEvent } from "react";

import type { ChatThreadBoardPaneState } from "../../chatThreadBoardStore";
import {
  getActiveThreadBoardDrag,
  subscribeActiveThreadBoardDrag,
} from "../../lib/threadBoardDrag";
import { cn } from "~/lib/utils";
import { ThreadBoardDropHint, ThreadBoardDropPreview } from "./ThreadBoardDropUi";
import { ThreadBoardPaneContent } from "./ThreadBoardPaneContent";
import type {
  ThreadBoardDropDirection,
  ThreadBoardPaneDragHandler,
  ThreadBoardPaneDragLeaveHandler,
  ThreadBoardPaneDragStartHandler,
} from "./threadBoardTypes";

const EMPTY_VISIBLE_BOARD_THREAD_IDS: readonly ThreadId[] = [];

function useThreadBoardDragActive(): boolean {
  return (
    useSyncExternalStore(
      subscribeActiveThreadBoardDrag,
      getActiveThreadBoardDrag,
      getActiveThreadBoardDrag,
    ) !== null
  );
}

function ThreadBoardPaneDropLayer(props: {
  dropPreviewDirection: ThreadBoardDropDirection | null | undefined;
  isSinglePane: boolean;
  pane: ChatThreadBoardPaneState;
  showDropHint: boolean | undefined;
  onPaneDragEnter: ThreadBoardPaneDragHandler | undefined;
  onPaneDragLeave: ThreadBoardPaneDragLeaveHandler | undefined;
  onPaneDragOver: ThreadBoardPaneDragHandler | undefined;
  onPaneDrop: ThreadBoardPaneDragHandler | undefined;
}) {
  const dragActive = useThreadBoardDragActive();
  const { pane } = props;

  return (
    <>
      {dragActive ? (
        <div
          className="absolute inset-0 z-20"
          onDragEnter={
            props.onPaneDragEnter
              ? (event) => {
                  event.stopPropagation();
                  props.onPaneDragEnter?.(pane, event);
                }
              : undefined
          }
          onDragLeave={
            props.onPaneDragLeave
              ? (event) => {
                  event.stopPropagation();
                  props.onPaneDragLeave?.(pane.id, event);
                }
              : undefined
          }
          onDragOver={
            props.onPaneDragOver
              ? (event) => {
                  event.stopPropagation();
                  props.onPaneDragOver?.(pane, event);
                }
              : undefined
          }
          onDrop={
            props.onPaneDrop
              ? (event) => {
                  event.stopPropagation();
                  props.onPaneDrop?.(pane, event);
                }
              : undefined
          }
        />
      ) : null}

      <AnimatePresence initial={false}>
        {props.dropPreviewDirection ? (
          <ThreadBoardDropPreview key="drop-preview" direction={props.dropPreviewDirection} />
        ) : dragActive && props.showDropHint ? (
          <ThreadBoardDropHint key="drop-hint" isSinglePane={props.isSinglePane} />
        ) : null}
      </AnimatePresence>
    </>
  );
}

export function ThreadBoardPane(props: {
  chatState: {
    shortcutsEnabled: boolean;
    showSidebarTrigger: boolean;
    splitPane?: boolean;
    visibleBoardThreadIds?: ReadonlyArray<ThreadId>;
  };
  dropPreviewDirection?: ThreadBoardDropDirection | null;
  pane: ChatThreadBoardPaneState;
  showDropHint?: boolean;
  visualState: {
    deferContent: boolean;
    isFocusedPane: boolean;
    isSinglePane: boolean;
  };
  onClosePane: (pane: ChatThreadBoardPaneState) => void;
  onPaneDragEnter?: ThreadBoardPaneDragHandler;
  onPaneDragLeave?: ThreadBoardPaneDragLeaveHandler;
  onPaneDragOver?: ThreadBoardPaneDragHandler;
  onPaneDrop?: ThreadBoardPaneDragHandler;
  onPaneDragEnd?: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onPaneDragStart?: ThreadBoardPaneDragStartHandler;
  setActivePane: (paneId: string) => void;
}) {
  const { pane } = props;
  const { chatState, visualState } = props;
  const visibleBoardThreadIds = chatState.visibleBoardThreadIds ?? EMPTY_VISIBLE_BOARD_THREAD_IDS;
  const isFocusedPane = visualState.isSinglePane || visualState.isFocusedPane;
  const isDimmedPane = !visualState.isSinglePane && !isFocusedPane;

  return (
    <div
      className={cn(
        "group/thread-pane relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
      )}
      onDragEnter={
        props.onPaneDragEnter
          ? (event) => {
              props.onPaneDragEnter?.(pane, event);
            }
          : undefined
      }
      onDragLeave={
        props.onPaneDragLeave
          ? (event) => {
              props.onPaneDragLeave?.(pane.id, event);
            }
          : undefined
      }
      onDragOver={
        props.onPaneDragOver
          ? (event) => {
              props.onPaneDragOver?.(pane, event);
            }
          : undefined
      }
      onDrop={
        props.onPaneDrop
          ? (event) => {
              props.onPaneDrop?.(pane, event);
            }
          : undefined
      }
      onPointerDown={() => {
        if (!isFocusedPane) {
          props.setActivePane(pane.id);
        }
      }}
      onFocusCapture={() => {
        if (!isFocusedPane) {
          props.setActivePane(pane.id);
        }
      }}
    >
      <ThreadBoardPaneContent
        chatState={{
          shortcutsEnabled: chatState.shortcutsEnabled,
          showSidebarTrigger: chatState.showSidebarTrigger,
          splitPane: chatState.splitPane,
          visibleBoardThreadIds,
        }}
        pane={pane}
        visualState={{
          deferContent: visualState.deferContent,
          isDimmedPane,
          isFocusedPane,
          isSinglePane: visualState.isSinglePane,
        }}
        onClosePane={props.onClosePane}
        onPaneDragEnd={props.onPaneDragEnd}
        onPaneDragStart={props.onPaneDragStart}
      />

      <ThreadBoardPaneDropLayer
        dropPreviewDirection={props.dropPreviewDirection}
        isSinglePane={visualState.isSinglePane}
        pane={pane}
        showDropHint={props.showDropHint}
        onPaneDragEnter={props.onPaneDragEnter}
        onPaneDragLeave={props.onPaneDragLeave}
        onPaneDragOver={props.onPaneDragOver}
        onPaneDrop={props.onPaneDrop}
      />

      {!visualState.isSinglePane ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-[33] border transition-[border-color,box-shadow] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
            "duration-300",
            isFocusedPane ? "border-primary/40" : "border-border/35",
          )}
        />
      ) : null}
    </div>
  );
}
