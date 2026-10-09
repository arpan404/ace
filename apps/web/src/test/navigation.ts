import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Open a profile view, returning from a section and opening the phone drawer when needed. */
export async function openProfileView(name: "Automations" | "Skills") {
  const back = screen.queryByRole("link", { name: "Back to app" });
  if (back) {
    await userEvent.click(back);
    await screen.findByRole("heading", { level: 1, name: "New thread" });
  }
  if (!screen.queryByRole("button", { name: /, account/ })) {
    await userEvent.click(await screen.findByRole("button", { name: "Back to threads" }));
  }
  await openProfileMenu();
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}

/** Wait for the popup's entrance before trying to select an item. */
export async function openProfileMenu() {
  await userEvent.click(await screen.findByRole("button", { name: /, account/ }));
  const menu = await screen.findByRole("menu");
  await waitFor(() => {
    if (getComputedStyle(menu).pointerEvents === "none")
      throw new Error("Profile menu is entering");
  });
  return menu;
}
