import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Open an Activity row before answering it, as a person does. */
export async function openActivityRequest(name: string | RegExp) {
  const card = await screen.findByRole("article", { name });
  const toggle = within(card).queryByRole("button", { name: /^Expand request:/ });
  if (toggle) await userEvent.click(toggle);
  return card;
}
