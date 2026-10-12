import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Open Work through its public shortcut, keeping an already selected Work tab open. */
export async function openWorkPanel() {
  if (!screen.queryByRole("tab", { name: "Work", selected: true }))
    await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const work = await screen.findByRole("tabpanel", { name: "Work" });
  await within(work).findByRole("region", { name: "Agents" });
  return work;
}

/** The header's Work icon; its name gains ", working" or ", something needs you" with a dot. */
export async function workButton() {
  return within(await screen.findByRole("banner")).findByRole("button", { name: /^Work/ });
}

/**
 * Open the thread's Work card from the header's Work icon (in a test's layout-less window, the
 * popover), keeping it as it is when already open. Resolves once its groups have drawn.
 */
export async function openWorkCard() {
  let card = screen.queryByRole("dialog", { name: "Work" });
  if (!card) {
    await userEvent.click(await workButton());
    card = await screen.findByRole("dialog", { name: "Work" });
  }
  await within(card).findByRole("region", { name: "Environment" });
  return card;
}

/** The Environment group's machine row: "<machine>, <Connected|Offline…>". */
export const machineRow = /, (Connected|Connecting|Offline|Pair again)$/;

/** Open the Work card's machine menu: folder, terminal and project scripts. */
export async function openMachineMenu() {
  const card = await openWorkCard();
  await userEvent.click(within(card).getByRole("button", { name: machineRow }));
  return screen.findByRole("menu");
}

/** Open the Work card's "More git actions" menu and pick `name` from it. */
export async function gitAction(name: string | RegExp) {
  const card = await openWorkCard();
  await userEvent.click(await within(card).findByRole("button", { name: "More git actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}
