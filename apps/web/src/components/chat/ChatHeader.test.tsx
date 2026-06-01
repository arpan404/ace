import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatHeader } from "./ChatHeader";

describe("ChatHeader", () => {
  it("keeps workspace diff counts out of the top header", () => {
    const markup = renderToStaticMarkup(
      <ChatHeader
        activeThreadTitle="Summary"
        activeProjectId={null}
        activeProjectName={undefined}
        isGitRepo
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
    expect(markup).not.toContain("-4");
  });

  it("keeps active todo progress out of the top header", () => {
    const markup = renderToStaticMarkup(
      <ChatHeader
        activeThreadTitle="Summary"
        activeProjectId={null}
        activeProjectName={undefined}
        isGitRepo
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
});
