import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Open Work through its public shortcut, keeping an already selected Work tab open. */
export async function openWorkPanel() {
  if (!screen.queryByRole("tab", { name: "Work", selected: true }))
    await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const work = await screen.findByRole("tabpanel", { name: "Work" });
  await within(work).findByRole("button", { name: "Project actions" });
  return work;
}
