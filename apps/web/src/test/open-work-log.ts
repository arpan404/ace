import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";

/**
 * Opens a finished turn's "Worked for" log the way a person does and waits for its steps (read
 * from the daemon as it opens), then opens every group so each step row is in view. Returns the
 * open log's steps.
 */
export async function openWorkLog(
  feed: HTMLElement,
  name: RegExp = /^Worked for/,
): Promise<HTMLElement> {
  await userEvent.click(await within(feed).findByRole("button", { name }));
  await waitFor(() =>
    expect(within(feed).queryByRole("status", { name: "Loading steps" })).toBeNull(),
  );
  const steps = await within(feed).findByRole("list", { name: "Steps" });
  for (;;) {
    const folded = steps.querySelector<HTMLElement>('[data-step-group][aria-expanded="false"]');
    if (!folded) break;
    await userEvent.click(folded);
  }
  return steps;
}
