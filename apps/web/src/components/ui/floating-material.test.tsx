import { configure, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";

configure({ asyncUtilTimeout: 10000 });

/** The floating material a layer was given: glass, or solid. */
function material(element: HTMLElement): "glass" | "solid" | "none" {
  if (element.classList.contains("ace-floating")) return "glass";
  if (element.classList.contains("ace-floating-solid")) return "solid";
  return "none";
}

function MoreMenu() {
  return (
    <Menu>
      <MenuTrigger>More</MenuTrigger>
      <MenuContent>
        <MenuItem>Rename</MenuItem>
      </MenuContent>
    </Menu>
  );
}

test("a menu opened from a glass popover is solid, so glass never sits on glass", async () => {
  render(
    <Popover>
      <PopoverTrigger>Details</PopoverTrigger>
      <PopoverContent aria-label="Details">
        <MoreMenu />
      </PopoverContent>
    </Popover>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Details" }));
  const popover = await screen.findByRole("dialog", { name: "Details" });
  expect(material(popover)).toBe("glass");
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  expect(material(await screen.findByRole("menu"))).toBe("solid");
});

test("a menu opened on its own, or from a solid dialog, is glass", async () => {
  render(
    <>
      <MoreMenu />
      <Dialog>
        <DialogTrigger>Settings</DialogTrigger>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <Menu>
            <MenuTrigger>Options</MenuTrigger>
            <MenuContent>
              <MenuItem>Reset</MenuItem>
            </MenuContent>
          </Menu>
        </DialogContent>
      </Dialog>
    </>,
  );
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  expect(material(await screen.findByRole("menu"))).toBe("glass");
  await userEvent.keyboard("{Escape}");

  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(material(dialog)).toBe("solid");
  await userEvent.click(screen.getByRole("button", { name: "Options" }));
  expect(material(await screen.findByRole("menu"))).toBe("glass");
});
