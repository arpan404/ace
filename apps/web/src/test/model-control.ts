import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";

/** Open the composer's model chip and return its popover. */
export async function openModelControl(chip: RegExp | string = /^Model: /): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: chip }));
  return screen.findByRole("dialog", { name: "Choose model" });
}

/** From the open popover, go to the model picker (it opens there when no model is chosen). */
export async function openModelPicker(popover: HTMLElement): Promise<HTMLElement> {
  const change = within(popover).queryByRole("button", { name: /^Change model/ });
  if (change) await userEvent.click(change);
  return within(popover).findByRole("listbox", { name: "Models" });
}

/**
 * Pick a model by searching for it, as a person would: "GPT-5 Codex" under "Codex". The row's
 * name may carry its detail or a default mark between the two ("Opus 5.5, default, Claude Code").
 */
export async function chooseModel(label: string, provider: string, chip?: RegExp | string) {
  const popover = await openModelControl(chip);
  await openModelPicker(popover);
  await userEvent.type(within(popover).getByRole("combobox", { name: "Search models" }), label);
  const row = within(popover)
    .getAllByRole("option")
    .find((option) => {
      const name = option.getAttribute("aria-label") ?? "";
      return name.startsWith(`${label}, `) && name.includes(`, ${provider}`);
    });
  if (!row) throw new Error(`No ${label} under ${provider} in the model picker`);
  await userEvent.click(row);
}

/** Close the popover and wait for it to leave, so the next control can open. */
export async function closeModelControl() {
  if (!screen.queryByRole("dialog", { name: /^(Choose model|Effort and speed)$/ })) return;
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: /^(Choose model|Effort and speed)$/ })).toBeNull(),
  );
}

/** Choose the same model on another account through its rail entry. */
export async function chooseAccount(popover: HTMLElement, name: string) {
  const list = await openModelPicker(popover);
  const model = within(list)
    .getAllByRole("option")
    .find((entry) => entry.getAttribute("aria-selected") === "true")
    ?.getAttribute("aria-label")
    ?.split(",")[0];
  if (name === "Add account…") {
    await userEvent.click(within(popover).getByRole("button", { name }));
    return;
  }
  await selectAccount(popover, name);
  const option = within(list)
    .getAllByRole("option")
    .find((entry) => entry.getAttribute("aria-label")?.startsWith(`${model},`));
  if (!option) throw new Error(`No ${model} on ${name}`);
  await userEvent.click(option);
}

/** Choose an account within the selected provider. */
export async function selectAccount(popover: HTMLElement, name: string) {
  const rail = within(popover).getByRole("tablist", { name: "Model sources" });
  const selected = within(rail).getByRole("tab", { selected: true });
  const provider = selected.getAttribute("aria-label")?.split(" · ")[0];
  await userEvent.click(within(rail).getByRole("tab", { name: `${provider} · ${name}` }));
}

/** Open the separate effort and speed popover from the composer's chip. */
export async function openEffortControl(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: /^Reasoning: / }));
  const popover = await screen.findByRole("dialog", { name: "Effort and speed" });
  await within(popover).findByRole("slider", { name: "Effort" });
  return popover;
}

/** Choose a catalog level through the slider's keyboard interface. */
export async function chooseEffort(popover: HTMLElement, keys: string) {
  const slider = within(popover).getByRole("slider", { name: "Effort" });
  slider.focus();
  await userEvent.keyboard(keys);
}
