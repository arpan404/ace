import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Open the side panel's Summary tab through its public shortcut, keeping an already selected
 * Summary tab open.
 */
export async function openWorkPanel() {
  if (!screen.queryByRole("tab", { name: "Summary", selected: true }))
    await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const work = await screen.findByRole("tabpanel", { name: "Summary" });
  await within(work).findByRole("region", { name: "Agents" });
  return work;
}

/** The header's thread details icon; its name gains ", working" or ", something needs you" with a dot. */
export async function workButton() {
  return within(await screen.findByRole("banner")).findByRole("button", {
    name: /^Thread details/,
  });
}

/**
 * Open the thread details card from the header's details icon (in a test's layout-less window,
 * the popover), keeping it as it is when already open. Resolves once its sections have drawn.
 */
export async function openWorkCard() {
  let card = screen.queryByRole("dialog", { name: "Thread details" });
  if (!card) {
    await userEvent.click(await workButton());
    card = await screen.findByRole("dialog", { name: "Thread details" });
  }
  await within(card).findByRole("region", { name: "Environment" });
  return card;
}

/** The Environment section's machine row: "<machine>, <Connected|Offline…>". */
export const machineRow = /, (Connected|Connecting|Offline|Pair again)$/;

/**
 * Open the details card's machine menu: the checkout's Local and Worktree moves, its path,
 * terminal, project scripts and Machine settings.
 */
export async function openMachineMenu() {
  const card = await openWorkCard();
  await userEvent.click(within(card).getByRole("button", { name: machineRow }));
  return screen.findByRole("menu");
}

/**
 * The checkout the machine menu marks current, "Local" or "Worktree" (the card shows it only as
 * the machine row's glyph). The menu closes again and the card stays open.
 */
export async function currentCheckout(): Promise<"Local" | "Worktree" | undefined> {
  const menu = await openMachineMenu();
  let current: "Local" | "Worktree" | undefined;
  for (const mode of ["Local", "Worktree"] as const) {
    const item = await within(menu).findByRole("menuitem", { name: new RegExp(`^${mode}`) });
    if (within(item).queryByText("current")) current = mode;
  }
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    if (screen.queryByRole("menu")) throw new Error("The machine menu is still open");
  });
  return current;
}

/** Open the details card's "More git actions" menu and pick `name` from it. */
export async function gitAction(name: string | RegExp) {
  const card = await openWorkCard();
  await userEvent.click(await within(card).findByRole("button", { name: "More git actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name }));
}
