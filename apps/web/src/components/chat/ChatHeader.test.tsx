import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatHeader } from "./ChatHeader";

describe("ChatHeader", () => {
  it("keeps workspace diff counts out of the top header", () => {
    const markup = renderToStaticMarkup(
      <ChatHeader
        activeThreadTitle="Summary"
        terminalAvailable
        terminalOpen={false}
        terminalToggleShortcutLabel={null}
        environmentPanelOpen
        rightSidePanelToggleShortcutLabel={null}
        rightSidePanelOpen={false}
        onToggleEnvironmentPanel={() => undefined}
        onToggleTerminal={() => undefined}
        onToggleRightSidePanel={() => undefined}
      />,
    );

    expect(markup).not.toContain("Workspace changes: 12 additions, 4 deletions");
    expect(markup).not.toContain("+12");
  });

  it("keeps active todo progress out of the top header", () => {
    const markup = renderToStaticMarkup(
      <ChatHeader
        activeThreadTitle="Summary"
        terminalAvailable
        terminalOpen={false}
        terminalToggleShortcutLabel={null}
        environmentPanelOpen
        rightSidePanelToggleShortcutLabel={null}
        rightSidePanelOpen={false}
        onToggleEnvironmentPanel={() => undefined}
        onToggleTerminal={() => undefined}
        onToggleRightSidePanel={() => undefined}
      />,
    );

    expect(markup).not.toContain("02/05");
    expect(markup).not.toContain("todo");
  });

  it("shows an unpin control only for pinned threads", () => {
    const pinnedMarkup = renderToStaticMarkup(
      <ChatHeader
        activeThreadTitle="Pinned thread"
        terminalAvailable
        terminalOpen={false}
        terminalToggleShortcutLabel={null}
        environmentPanelOpen
        rightSidePanelToggleShortcutLabel={null}
        rightSidePanelOpen={false}
        pinnedThread
        onUnpinThread={() => undefined}
        onToggleEnvironmentPanel={() => undefined}
        onToggleTerminal={() => undefined}
        onToggleRightSidePanel={() => undefined}
      />,
    );
    const unpinnedMarkup = renderToStaticMarkup(
      <ChatHeader
        activeThreadTitle="Unpinned thread"
        terminalAvailable
        terminalOpen={false}
        terminalToggleShortcutLabel={null}
        environmentPanelOpen
        rightSidePanelToggleShortcutLabel={null}
        rightSidePanelOpen={false}
        onToggleEnvironmentPanel={() => undefined}
        onToggleTerminal={() => undefined}
        onToggleRightSidePanel={() => undefined}
      />,
    );

    expect(pinnedMarkup).toContain("Unpin Pinned thread");
    expect(unpinnedMarkup).not.toContain("Unpin Unpinned thread");
  });

  it("uses a thread actions menu instead of a project label in the title area", () => {
    const markup = renderToStaticMarkup(
      <ChatHeader
        activeThreadTitle="Menu thread"
        terminalAvailable
        terminalOpen={false}
        terminalToggleShortcutLabel={null}
        environmentPanelOpen
        rightSidePanelToggleShortcutLabel={null}
        rightSidePanelOpen={false}
        menuActions={{
          canArchive: true,
          canCopyWorkspacePath: true,
          canFork: true,
          canOpenSideChat: true,
          canOpenWindow: true,
          onArchive: () => undefined,
          onCopyLink: () => undefined,
          onCopyThreadId: () => undefined,
          onCopyTitle: () => undefined,
          onCopyWorkspacePath: () => undefined,
          onFork: () => undefined,
          onOpenSideChat: () => undefined,
          onOpenWindow: () => undefined,
          onRename: () => undefined,
          onTogglePinned: () => undefined,
          pinned: false,
        }}
        onToggleEnvironmentPanel={() => undefined}
        onToggleTerminal={() => undefined}
        onToggleRightSidePanel={() => undefined}
      />,
    );

    expect(markup).toContain("Thread actions");
    expect(markup).not.toContain("No Git");
  });
});
