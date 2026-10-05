import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { IconButton } from "./icon-button.tsx";
import { TooltipProvider } from "./tooltip.tsx";

test("a disabled icon button can still be focused, says why in its tooltip, and does nothing", async () => {
  const onClick = vi.fn();
  render(
    <TooltipProvider>
      <IconButton
        icon={DownloadSimpleIcon}
        label="Download"
        disabled
        reason="Deleted in this thread"
        onClick={onClick}
      />
    </TooltipProvider>,
  );
  const button = screen.getByRole("button", { name: "Download" });
  await userEvent.tab();
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect((await screen.findByRole("tooltip")).textContent).toBe("Deleted in this thread");
  await userEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});
