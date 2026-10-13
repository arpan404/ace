import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Full-text search, as a person reaches it: the launcher (⌘K), then its "Search all threads".
 * Resolves with the search sheet's field once it has focus to type in.
 */
export async function openSearchSheet(): Promise<HTMLInputElement> {
  await userEvent.keyboard("{Meta>}k{/Meta}");
  const palette = await screen.findByRole("dialog", { name: "Command palette" });
  await userEvent.type(within(palette).getByRole("combobox"), "search all");
  await userEvent.click(
    await within(palette).findByRole("option", { name: /^Search all threads(?! for)/ }),
  );
  await screen.findByRole("dialog", { name: "Search" });
  return screen.getByRole<HTMLInputElement>("combobox", { name: "Search every thread" });
}
