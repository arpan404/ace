import type {
  ChatThreadBoardLayoutAxis,
  ChatThreadBoardLayoutNode,
  ChatThreadBoardPaneState,
} from "../../chatThreadBoardStore";
import type { ThreadId } from "@ace/contracts";
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

export type ThreadBoardDropDirection = "down" | "left" | "right" | "up";

export type ThreadBoardPaneDragHandler = (
  pane: ChatThreadBoardPaneState,
  event: ReactDragEvent<HTMLDivElement>,
) => void;

export type ThreadBoardPaneDragLeaveHandler = (
  paneId: string,
  event: ReactDragEvent<HTMLDivElement>,
) => void;

export type ThreadBoardPaneDragStartHandler = (
  pane: ChatThreadBoardPaneState,
  label: string,
  event: ReactDragEvent<HTMLButtonElement>,
) => void;

export type ThreadBoardLayoutNodeRendererProps = {
  node: ChatThreadBoardLayoutNode | null;
  renderPaneNode: (paneId: string) => ReactNode;
  branchRefs: { current: Map<string, HTMLDivElement> };
  handleBranchResizeStart: (
    branchId: string,
    axis: ChatThreadBoardLayoutAxis,
    index: number,
  ) => (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleBranchResizeMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleBranchResizeEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
};

export type ThreadBoardPaneContentProps = {
  chatState: {
    shortcutsEnabled: boolean;
    showSidebarTrigger: boolean;
    splitPane: boolean | undefined;
    visibleBoardThreadIds: ReadonlyArray<ThreadId>;
  };
  pane: ChatThreadBoardPaneState;
  visualState: {
    deferContent: boolean;
    isDimmedPane: boolean;
    isFocusedPane: boolean;
    isSinglePane: boolean;
  };
  onClosePane: (pane: ChatThreadBoardPaneState) => void;
  onPaneDragEnd: ((event: ReactDragEvent<HTMLButtonElement>) => void) | undefined;
  onPaneDragStart: ThreadBoardPaneDragStartHandler | undefined;
};
