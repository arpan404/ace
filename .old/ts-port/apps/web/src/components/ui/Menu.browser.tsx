import "../../index.css";

import { ChevronDownIcon } from "lucide-react";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { Button } from "./button";
import { Dialog, DialogPopup } from "./dialog";
import { FLOATING_LAYER_CLASS_NAME, MODAL_LAYER_CLASS_NAME } from "./layers";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";

function numericZIndex(element: Element): number {
  return Number.parseInt(window.getComputedStyle(element).zIndex, 10);
}

describe("Menu", () => {
  it("renders popups above modal dialogs", async () => {
    await render(
      <Dialog defaultOpen>
        <DialogPopup showCloseButton={false}>
          <div className="p-6">
            <Menu>
              <MenuTrigger
                render={<Button aria-label="Issue solve actions" size="sm" variant="default" />}
              >
                <ChevronDownIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end" side="top">
                <MenuItem>Solve each issue in parallel worktrees</MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        </DialogPopup>
      </Dialog>,
    );

    await page.getByLabelText("Issue solve actions").click();

    await expect
      .element(page.getByText("Solve each issue in parallel worktrees"))
      .toBeInTheDocument();

    const modalLayer = document.querySelector("[data-slot='dialog-viewport']");
    const menuLayer = document.querySelector("[data-slot='menu-positioner']");

    expect(modalLayer).not.toBeNull();
    expect(menuLayer).not.toBeNull();
    expect(modalLayer).toHaveClass(MODAL_LAYER_CLASS_NAME);
    expect(menuLayer).toHaveClass(FLOATING_LAYER_CLASS_NAME);
    expect(numericZIndex(menuLayer as Element)).toBeGreaterThan(
      numericZIndex(modalLayer as Element),
    );
  });
});
