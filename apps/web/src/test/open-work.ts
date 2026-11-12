import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { findTopBar } from "./top-bar.ts";

/**
 * Open the side panel's Summary tab through its public shortcut, keeping an already selected
 * Summary tab open.
 */
export async function openWorkPanel() {
  if (!screen.queryByRole("tab", { name: "Summary", selected: true }))
    await userEvent.keyboard("{Control>}{Shift>}a{/Shift}{/Control}");
  const work = await screen.findByRole("tabpanel", { name: "Summary" });
  // Its sections draw once the thread's facts are in (a skeleton stands in until then).
  await waitFor(() => {
    if (!work.querySelector("[data-summary]")) throw new Error("The summary is still loading");
  });
  return work;
}

/**
 * The Summary's full agent tree, opened from its "Show all agents" line when it is folded away
 * (the choice is kept with the tab, so it stays open from then on).
 */
export async function agentTree(work: HTMLElement) {
  const shown = within(work).queryByRole("tree", { name: "Agent tree" });
  if (shown) return shown;
  await userEvent.click(await within(work).findByRole("button", { name: /^Show all agents/ }));
  return within(work).findByRole("tree", { name: "Agent tree" });
}

/**
 * An agent's row in the Summary's agent tree by the agent's name ("Explore the panel: Read 41
 * files" is found by "Explore the panel"), opening the tree and waiting until the row shows.
 */
export async function agentRow(work: HTMLElement, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await agentTree(work);
  return within(work).findByRole("treeitem", { name: new RegExp(`^${escaped}: `) });
}

/** Whether a tree row's provider mark breathes: it, or something under it, works or waits. */
export function isBreathing(row: HTMLElement): boolean {
  return row.querySelector("[data-breathing]") !== null;
}

/** The Summary's Still running list: only live work, absent once nothing anywhere may run. */
export function stillRunning(work: HTMLElement) {
  return within(work).queryByRole("region", { name: "Still running" });
}

/** A row of Still running by its name ("Cold build: syncing"), waiting until it shows. */
export async function liveRow(work: HTMLElement, name: string | RegExp) {
  return within(await within(work).findByRole("region", { name: "Still running" })).findByRole(
    "button",
    { name },
  );
}

/** The header's thread details icon; its name gains ", working" or ", something needs you" with a dot. */
export async function workButton() {
  return within(await findTopBar()).findByRole("button", {
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
  await within(card).findByRole("region", { name: "Workspace" });
  return card;
}

/** The Workspace section's machine row: "<machine>, <Connected|Offline…>". */
export const machineRow = /, (Connected|Connecting|Offline|Pair again)$/;

/**
 * Open the details card's machine menu: the checkout's Local and Worktree moves, its path,
 * path and terminal. The project's scripts live in Run a script.
 */
export async function openMachineMenu() {
  const card = await openWorkCard();
  await userEvent.click(within(card).getByRole("button", { name: machineRow }));
  return screen.findByRole("menu");
}

/**
 * The checkout the machine menu marks current, "Local" or "Worktree" (the card shows it only as
 * the machine row's words after its name). The menu closes again and the card stays open.
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

/** Open the details card's "Run a script" list; resolves to its search field's popup. */
export async function openRunScript() {
  const card = await openWorkCard();
  await userEvent.click(within(card).getByRole("button", { name: "Run a script" }));
  return screen.findByRole("dialog", { name: "Run a script" });
}

/** Open the details card's git menu, from the caret on its sync row. */
export async function openGitMenu() {
  const card = await openWorkCard();
  await userEvent.click(await within(card).findByRole("button", { name: "More git actions" }));
  return screen.findByRole("menu");
}

/** Open the details card's "More git actions" menu and pick `name` from it. */
export async function gitAction(name: string | RegExp) {
  await userEvent.click(await within(await openGitMenu()).findByRole("menuitem", { name }));
}

/** The git menu's item marked as the next step ("next"), by its name. */
export async function nextGitStep() {
  const menu = await openGitMenu();
  const next = within(menu)
    .getAllByRole("menuitem")
    .find((item) => within(item).queryByText("next"));
  const name = next?.textContent?.replace(/next$/, "");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    if (screen.queryByRole("menu")) throw new Error("The git menu is still open");
  });
  return name;
}

/** Open every folded "N done" line of the agent tree, so the finished agents' rows show. */
export async function showFinished(work: HTMLElement) {
  await agentTree(work);
  for (const row of within(work).queryAllByRole("treeitem", { name: /^\d+ done$/ }))
    if (row.getAttribute("aria-expanded") === "false") await userEvent.click(row);
}
