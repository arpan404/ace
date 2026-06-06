import { ThreadId } from "@ace/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { SidebarThreadRow as SidebarThreadRowType } from "./SidebarThreadRow";

const threadId = ThreadId.makeUnsafe("thread-row-test");

vi.mock("../../storeSelectors", () => ({
  useSidebarThreadSummaryById: (id: ThreadId) => ({
    id,
    title: "Provider feature thread",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    branch: null,
    fork: null,
    session: null,
    worktreePath: null,
  }),
}));

vi.mock("../../terminalStateStore", () => ({
  selectThreadTerminalState: () => ({ runningTerminalIds: [] }),
  useTerminalStateStore: <T,>(selector: (state: { terminalStateByThreadId: {} }) => T) =>
    selector({ terminalStateByThreadId: {} }),
}));

vi.mock("../../uiStateStore", () => ({
  useUiStateStore: <T,>(selector: (state: { threadLastVisitedAtById: {} }) => T) =>
    selector({ threadLastVisitedAtById: {} }),
}));

let SidebarThreadRow: typeof SidebarThreadRowType;

beforeAll(async () => {
  ({ SidebarThreadRow } = await import("./SidebarThreadRow"));
});

function renderThreadRow() {
  return renderToStaticMarkup(
    <SidebarThreadRow
      activeRouteConnectionUrl="ws://localhost:3778"
      appSettingsConfirmThreadArchive={true}
      attemptArchiveThread={() => Promise.resolve()}
      cancelRename={() => undefined}
      clearSelection={() => undefined}
      commitRename={() => Promise.resolve()}
      confirmingArchiveThreadId={null}
      confirmArchiveButtonRefs={{ current: new Map<ThreadId, HTMLButtonElement>() }}
      connectionUrl="ws://localhost:3778"
      handleMultiSelectContextMenu={() => Promise.resolve()}
      handleThreadClick={() => undefined}
      handleThreadContextMenu={() => Promise.resolve()}
      isPinned={false}
      jumpLabel={null}
      navigateToThread={() => undefined}
      onTogglePinnedThread={() => undefined}
      openPrLink={() => undefined}
      orderedProjectThreadIds={[threadId]}
      pinEnabled={true}
      pr={null}
      prefetchThreadHistory={() => undefined}
      renamingCommittedRef={{ current: false }}
      renamingInputRef={{ current: null }}
      renamingThreadId={null}
      renamingTitle=""
      routeThreadId={null}
      selectedThreadIds={new Set()}
      setConfirmingArchiveThreadId={() => undefined}
      setRenamingTitle={() => undefined}
      showThreadJumpHints={false}
      threadId={threadId}
    />,
  );
}

describe("SidebarThreadRow", () => {
  it("renders the selectable row without nesting action buttons inside a native button", () => {
    const markup = renderThreadRow();

    expect(markup).toContain('data-testid="thread-row-thread-row-test"');
    expect(markup).toContain('role="button"');
    expect(markup).toContain('data-testid="thread-pin-thread-row-test"');
    expect(markup).not.toContain('<button type="button" data-active=');
  });
});
