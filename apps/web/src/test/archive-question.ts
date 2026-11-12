import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The button that goes on with an archive the app asked about, if it asked: Archive, for a done
 * thread that left a command running (archiving stops it, ADR 0109), or Archive, keep running,
 * for a thread that still works.
 */
export function archiveAnyway(): HTMLElement | null {
  const stops = screen.queryByRole("dialog", { name: /^Archive (thread|\d+ threads)\?$/ });
  return stops
    ? within(stops).getByRole("button", { name: "Archive" })
    : screen.queryByRole("button", { name: "Archive, keep running" });
}

/** Answer Archive when archiving would stop a command the thread left running. */
export async function archiveStoppingCommands(): Promise<void> {
  const ask = await screen.findByRole("dialog", { name: /^Archive (thread|\d+ threads)\?$/ });
  await userEvent.click(within(ask).getByRole("button", { name: "Archive" }));
}
