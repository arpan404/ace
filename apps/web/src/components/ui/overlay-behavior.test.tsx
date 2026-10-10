import { configure, render, screen, waitFor } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test } from "vitest";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "./context-menu.tsx";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog.tsx";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandCollection,
  CommandItem,
} from "./command.tsx";

configure({ asyncUtilTimeout: 10000 });

function Actions() {
  const [picked, setPicked] = useState("Nothing chosen");
  return (
    <>
      <p role="status">{picked}</p>
      <Menu>
        <MenuTrigger>Actions</MenuTrigger>
        <MenuContent>
          <MenuItem onClick={() => setPicked("Renamed")}>Rename</MenuItem>
          <MenuItem onClick={() => setPicked("Pinned")}>Pin</MenuItem>
        </MenuContent>
      </Menu>
    </>
  );
}
test("menu arrows and Enter choose an action and Escape returns focus", async () => {
  render(<Actions />);
  const trigger = screen.getByRole("button", { name: "Actions" });
  await userEvent.click(trigger);
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(screen.getByRole("status").textContent).toBe("Renamed");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await userEvent.click(trigger);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
test("a popover closes on Escape and restores its trigger", async () => {
  render(
    <Popover>
      <PopoverTrigger>Options</PopoverTrigger>
      <PopoverContent>
        <button>Pick</button>
      </PopoverContent>
    </Popover>,
  );
  const trigger = screen.getByRole("button", { name: "Options" });
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole("button", { name: "Pick" }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Pick" })).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
test("a dialog keeps Tab focus inside and Escape restores its opener", async () => {
  render(
    <Dialog>
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent>
        <DialogTitle>Rename</DialogTitle>
        <input aria-label="Title" />
        <button>Save</button>
      </DialogContent>
    </Dialog>,
  );
  const trigger = screen.getByRole("button", { name: "Open dialog" });
  await userEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Rename" });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  for (let step = 0; step < 6; step++) {
    await userEvent.tab();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  }
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
function Palette() {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  return (
    <>
      <button onClick={() => setOpen(true)}>Open palette</button>
      <p role="status">{choice}</p>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <Command
          items={[{ value: "Actions", items: ["Rename", "Pin"] }]}
          itemToStringValue={(item: string) => item}
        >
          <CommandInput aria-label="Find action" />
          <CommandList>
            {(group: { value: string; items: string[] }) => (
              <CommandGroup items={group.items}>
                <CommandCollection>
                  {(item: string) => (
                    <CommandItem
                      value={item}
                      onClick={() => {
                        setChoice(item);
                        setOpen(false);
                      }}
                    >
                      {item}
                    </CommandItem>
                  )}
                </CommandCollection>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
test("the command sheet focuses search, filters and selects with the keyboard", async () => {
  render(<Palette />);
  await userEvent.click(screen.getByRole("button", { name: "Open palette" }));
  const input = await screen.findByRole("combobox", { name: "Find action" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  await userEvent.type(input, "Pin{Enter}");
  expect(screen.getByRole("status").textContent).toBe("Pin");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

function ContextRename() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={<button>Thread</button>} />
        <ContextMenuContent>
          <MenuItem onClick={() => setOpen(true)}>Rename</MenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Rename thread</DialogTitle>
          <input aria-label="Title" />
          <button>Save</button>
        </DialogContent>
      </Dialog>
    </>
  );
}
test("a context menu can open a dialog without pulling focus out of its form", async () => {
  render(<ContextRename />);
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: screen.getByRole("button", { name: "Thread" }),
  });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const input = await screen.findByRole("textbox", { name: "Title" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  await userEvent.type(input, "New title");
  expect(input).toHaveProperty("value", "New title");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
