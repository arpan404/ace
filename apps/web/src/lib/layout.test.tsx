import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { LayoutProvider, useLayout, useOptionalStorage } from "./layout.tsx";
import { useScopeWorkspace, useWorkspaceActions } from "./workspace/react.tsx";

function Controls() {
  const { paletteOpen, setPaletteOpen, setSidebarWidth, setComposerActions } = useLayout();
  return (
    <>
      <output aria-label="palette">{String(paletteOpen)}</output>
      <button onClick={() => setPaletteOpen(!paletteOpen)}>Toggle palette</button>
      <button onClick={() => setSidebarWidth(400)}>Resize sidebar</button>
      <button
        onClick={() => setComposerActions({ scope: "thread", chooseModel() {}, tuneEffort() {} })}
      >
        Register composer
      </button>
    </>
  );
}

test("shell changes leave storage readers and unrelated workspaces asleep", () => {
  let storageRenders = 0;
  let workspaceRenders = 0;
  function StorageReader() {
    storageRenders++;
    const storage = useOptionalStorage();
    return <output aria-label="storage">{storage ? "persistent" : "memory"}</output>;
  }
  function WorkspaceReader() {
    workspaceRenders++;
    const workspace = useScopeWorkspace("thread");
    const actions = useWorkspaceActions("thread");
    return (
      <button onClick={() => actions.setSize(420, false)}>Workspace width {workspace.size}</button>
    );
  }
  render(
    <LayoutProvider>
      <Controls />
      <StorageReader />
      <WorkspaceReader />
    </LayoutProvider>,
  );
  const beforeStorage = storageRenders;
  const beforeWorkspace = workspaceRenders;
  fireEvent.click(screen.getByText("Toggle palette"));
  expect(screen.getByLabelText("palette").textContent).toBe("true");
  fireEvent.click(screen.getByText("Resize sidebar"));
  fireEvent.click(screen.getByText("Register composer"));
  expect(storageRenders).toBe(beforeStorage);
  expect(workspaceRenders).toBe(beforeWorkspace);
  fireEvent.click(screen.getByText(/Workspace width/));
  expect(screen.getByText("Workspace width 420")).toBeTruthy();
});

function Reader() {
  return <output>{useOptionalStorage() === localStorage ? "persistent" : "memory"}</output>;
}

test("optional storage follows its provider and remains optional outside the shell", () => {
  const view = render(<Reader />);
  expect(view.container.textContent).toBe("memory");
  view.rerender(
    <LayoutProvider>
      <Reader />
    </LayoutProvider>,
  );
  expect(view.container.textContent).toBe("memory");
  view.rerender(
    <LayoutProvider storage={localStorage}>
      <Reader />
    </LayoutProvider>,
  );
  expect(view.container.textContent).toBe("persistent");
});
