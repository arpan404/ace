import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { setKeybindingOverrides } from "@/lib/keybindings.ts";
import { IconButton } from "./icon-button.tsx";
import { TooltipProvider } from "./tooltip.tsx";

afterEach(() => setKeybindingOverrides({}));

test("a control's own keys stay as written when a shortcut spelled the same is rebound", async () => {
  setKeybindingOverrides({ palette: "shift+mod+y" });
  render(
    <TooltipProvider>
      <IconButton icon={MagnifyingGlassIcon} label="Search here" keys="mod+k" resolve={false} />
      <IconButton icon={MagnifyingGlassIcon} label="Open palette" keys="mod+k" />
    </TooltipProvider>,
  );
  screen.getByRole("button", { name: "Search here" }).focus();
  expect((await screen.findByRole("tooltip")).textContent).toBe("Search hereCtrl+K");
  screen.getByRole("button", { name: "Open palette" }).focus();
  await vi.waitFor(() =>
    expect(screen.getByRole("tooltip").textContent).toBe("Open paletteShift+Ctrl+Y"),
  );
});

test("keys that only mean something in one place (Enter in Activity) never borrow its rebinding", async () => {
  setKeybindingOverrides({ "activity.open": "mod+o" });
  render(
    <TooltipProvider>
      <IconButton icon={MagnifyingGlassIcon} label="Next match" keys="enter" />
    </TooltipProvider>,
  );
  screen.getByRole("button", { name: "Next match" }).focus();
  expect((await screen.findByRole("tooltip")).textContent).toBe("Next matchEnter");
});
