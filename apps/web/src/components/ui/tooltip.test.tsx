import { configure, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./menu.tsx";
import { Tip, TooltipProvider } from "./tooltip.tsx";

configure({ asyncUtilTimeout: 5_000 });

function Composer() {
  return (
    <TooltipProvider delay={0}>
      <Menu>
        <MenuTrigger render={<button type="button">Add</button>} />
        <MenuContent>
          <Tip label="Pick files to attach">
            <MenuItem>Attach files</MenuItem>
          </Tip>
        </MenuContent>
      </Menu>
      <Tip label="Approvals: Provider default">
        <button type="button">Approvals</button>
      </Tip>
    </TooltipProvider>
  );
}

test("a control behind an open menu keeps its tooltip hidden, while the menu's own still show", async () => {
  render(<Composer />);
  await userEvent.hover(screen.getByRole("button", { name: "Approvals" }));
  expect((await screen.findByRole("tooltip")).textContent).toBe("Approvals: Provider default");
  await userEvent.unhover(screen.getByRole("button", { name: "Approvals" }));

  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  const item = await screen.findByRole("menuitem", { name: "Attach files" });
  await userEvent.hover(screen.getByRole("button", { name: "Approvals", hidden: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(screen.queryByText("Approvals: Provider default")).toBeNull();

  await userEvent.hover(item);
  expect(await screen.findByText("Pick files to attach")).toBeTruthy();
});
