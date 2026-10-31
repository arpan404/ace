import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Open a place from the sidebar's rail, opening the phone's sidebar sheet first when needed. */
export async function openProfileView(name: "Automations" | "Skills") {
  if (!screen.queryByRole("navigation", { name: "App" })) {
    await userEvent.click(
      await screen.findByRole("button", { name: /^(Back to threads|Show sidebar)$/ }),
    );
  }
  const rail = await screen.findByRole("navigation", { name: "App" });
  await userEvent.click(within(rail).getByRole("link", { name }));
}

/** Go back to Threads from the sidebar's rail: the thread (or New thread) the person left. */
export async function openThreads() {
  const rail = await screen.findByRole("navigation", { name: "App" });
  await userEvent.click(within(rail).getByRole("link", { name: /^Threads/ }));
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
