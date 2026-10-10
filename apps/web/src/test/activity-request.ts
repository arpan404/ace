import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Open an Activity row before answering it, as a person does. */
export async function openActivityRequest(name: string | RegExp) {
  if (!screen.queryByRole("article", { name })) {
    const rows = within(
      await within(await screen.findByRole("complementary", { name: "Activity" })).findByRole(
        "list",
        { name: "Activity" },
      ),
    );
    const match =
      typeof name === "string"
        ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
        : name;
    await userEvent.click(await rows.findByRole("button", { name: match }));
  }
  const card = await screen.findByRole("article", { name });
  const toggle = within(card).queryByRole("button", { name: /^Expand request:/ });
  if (toggle) await userEvent.click(toggle);
  return card;
}
