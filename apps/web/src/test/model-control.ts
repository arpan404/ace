import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";

/** Open the composer's model chip and return its popover. */
export async function openModelControl(chip: RegExp | string = /^Model: /): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: chip }));
  return screen.findByRole("dialog", { name: "Model and effort" });
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
  // A picked model lands on Tune; the pick is done, so put the popover away.
  await closeModelControl();
}

/** Close the popover and wait for it to leave, so the next control can open. */
export async function closeModelControl() {
  if (!screen.queryByRole("dialog", { name: "Model and effort" })) return;
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Model and effort" })).toBeNull(),
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
  await closeModelControl();
}

/**
 * A model source's tab, "Codex · Team": the rail's own tab when the provider has one account,
 * else the account's tab in the list header once the provider's rail tab is selected.
 */
export async function sourceTab(popover: HTMLElement, name: string): Promise<HTMLElement> {
  const rail = within(popover).getByRole("tablist", { name: "Model sources" });
  const direct = within(rail).queryByRole("tab", { name });
  if (direct) return direct;
  await userEvent.click(within(rail).getByRole("tab", { name: name.split(" · ")[0] ?? name }));
  const accounts = within(popover).getByRole("tablist", { name: "Accounts" });
  return within(accounts).getByRole("tab", { name });
}

/** Show a model source's models: "Codex · Team". */
export async function chooseSource(popover: HTMLElement, name: string) {
  await userEvent.click(await sourceTab(popover, name));
}

/** Choose an account within the selected provider. */
export async function selectAccount(popover: HTMLElement, name: string) {
  const rail = within(popover).getByRole("tablist", { name: "Model sources" });
  const selected = within(rail).getByRole("tab", { selected: true });
  const provider = selected.getAttribute("aria-label")?.split(" · ")[0];
  await chooseSource(popover, `${provider} · ${name}`);
}

/** Open the model chip on its Tune pane, where effort and speed are. */
export async function openEffortControl(chip: RegExp | string = /^Model: /): Promise<HTMLElement> {
  // The chip's effort (or speed) opens Tune; its name opens the model list.
  const button = await screen.findByRole("button", { name: chip });
  // The effort shows once the catalog has the model; a model with nothing to tune has none.
  const tune = await waitFor(
    () => {
      const part = button.querySelector<HTMLElement>("[data-model-tune] > *");
      if (!part) throw new Error("no effort or speed on the chip yet");
      return part;
    },
    { timeout: 2000 },
  ).catch(() => null);
  await userEvent.click(tune ?? button);
  const popover = await screen.findByRole("dialog", { name: "Model and effort" });
  await within(popover).findByRole("slider", { name: "Effort" });
  return popover;
}

/** Choose a speed in the open Tune pane's segment. */
export async function chooseSpeed(popover: HTMLElement, speed: "Standard" | "Fast" | "Ultrafast") {
  const segment = within(popover).getByRole("radiogroup", { name: "Speed" });
  await userEvent.click(within(segment).getByRole("radio", { name: speed }));
}

/** Choose a catalog level through the slider's keyboard interface. */
export async function chooseEffort(popover: HTMLElement, keys: string) {
  const slider = within(popover).getByRole("slider", { name: "Effort" });
  slider.focus();
  await userEvent.keyboard(keys);
}

/** Move the open Tune pane's effort slider to the level named `level` ("Low", "High"). */
export async function chooseEffortLevel(popover: HTMLElement, level: string) {
  const slider = within(popover).getByRole("slider", { name: "Effort" });
  await chooseEffort(popover, "{Home}");
  for (let step = 0; step < 10 && slider.getAttribute("aria-valuetext") !== level; step++)
    await userEvent.keyboard("{ArrowRight}");
  expect(slider.getAttribute("aria-valuetext")).toBe(level);
}
