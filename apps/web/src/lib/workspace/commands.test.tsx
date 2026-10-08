import { FileIcon } from "@phosphor-icons/react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { expect, test } from "vitest";
import { LayoutProvider } from "@/lib/layout.tsx";
import {
  defineTabKind,
  defineWorkspace,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceCommands,
  useWorkspaceStore,
} from "./index.ts";

const view = { load: () => Promise.resolve({ default: () => null }) };
const definition = defineWorkspace({
  label: "Side panel",
  launcher: "file",
  initial: [
    { kind: "file", id: "a", title: "notes.md" },
    { kind: "file", id: "b", title: "todo.md" },
  ],
  kinds: () =>
    Promise.resolve({
      default: [defineTabKind({ kind: "file", label: "File", icon: FileIcon, ...view })],
    }),
});

/** The palette's view of the commands: one button each, named by its label. */
function Palette() {
  const store = useWorkspaceStore();
  store.define("thread", definition);
  useEffect(() => store.setFocused("thread"), [store]);
  const workspace = useScopeWorkspace("thread");
  const actions = useWorkspaceActions("thread");
  const commands = useWorkspaceCommands();
  return (
    <>
      <button type="button" onClick={() => actions.setOpen(true)}>
        Show side panel
      </button>
      <p>{workspace.tabs.map((tab) => tab.title).join(", ")}</p>
      {commands.map((command) => (
        <button
          key={command.id}
          type="button"
          aria-disabled={command.disabled ? true : undefined}
          aria-description={command.disabled}
          onClick={() => !command.disabled && command.run()}
        >
          {command.label}
        </button>
      ))}
    </>
  );
}

test("the palette's tab commands act on the showing tab, and bring back the tab closed last", async () => {
  await definition.load();
  render(
    <LayoutProvider>
      <Palette />
    </LayoutProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Show side panel" }));
  const reopen = screen.getByRole("button", { name: "Reopen closed tab" });
  expect(reopen.getAttribute("aria-description")).toBe("No closed tabs");

  await userEvent.click(screen.getByRole("button", { name: "Pin notes.md" }));
  expect(screen.getByRole("button", { name: "Unpin notes.md" })).toBeTruthy();
  // notes.md is pinned now, so todo.md is the other tab to close.
  await act(() => userEvent.click(screen.getByRole("button", { name: "Close other tabs" })));
  expect(screen.getByText("notes.md")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Reopen closed tab" }));
  expect(screen.getByText("notes.md, todo.md")).toBeTruthy();
});
