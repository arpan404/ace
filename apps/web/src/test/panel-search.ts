import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * A panel's search, as a person opens it: the magnifier at the end of its title row ("Search
 * skills"), which turns into the field. Resolves with the field once it is open.
 */
export async function openPanelSearch(label: string): Promise<HTMLInputElement> {
  await userEvent.click(await screen.findByRole("button", { name: label }));
  return screen.findByRole<HTMLInputElement>("searchbox", { name: label });
}
