import { replayCursor, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import {
  chooseEffort,
  closeModelControl,
  openEffortControl,
  openModelControl,
  openModelPicker,
} from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

async function openThread() {
  const app = harness();
  app.daemon.services.models = app.daemon.services.models.map((model) =>
    model.provider === "claude"
      ? {
          ...model,
          reasoningEfforts: ["light", "medium", "high", "ultra"],
          defaultEffort: "medium",
        }
      : model,
  );
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  return app;
}

async function openNewThread() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/new?project=relay");
  return app;
}

/** Pick a model in the open popover's picker by searching for it. */
async function pick(popover: HTMLElement, label: string, provider: string) {
  await openModelPicker(popover);
  await userEvent.type(within(popover).getByRole("combobox", { name: "Search models" }), label);
  const row = within(popover)
    .getAllByRole("option")
    .find((option) => {
      const name = option.getAttribute("aria-label") ?? "";
      return name.startsWith(`${label}, `) && name.includes(provider);
    });
  if (!row) throw new Error(`No ${label} under ${provider}`);
  await userEvent.click(row);
}

const chipEffort = () =>
  screen.getByRole("button", { name: /^Model: / }).querySelector("[data-slot=model-effort]")
    ?.textContent;

test("the effort slider snaps to the model's levels, and Reset goes back to its default", async () => {
  await openThread();
  const popover = await openEffortControl();
  const slider = within(popover).getByRole("slider", { name: "Effort" });
  expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
  await chooseEffort(popover, "{End}");
  expect(slider.getAttribute("aria-valuetext")).toBe("Ultra");
  expect(chipEffort()).toBe("Ultra");
  await userEvent.keyboard("{ArrowLeft}");
  expect(slider.getAttribute("aria-valuetext")).toBe("High");
  await userEvent.keyboard("{Home}");
  expect(slider.getAttribute("aria-valuetext")).toBe("Light");
  await userEvent.keyboard("{End}");
  await userEvent.click(within(popover).getByRole("button", { name: "Reset effort" }));
  expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Model and effort" })).toBeNull(),
  );
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Model: Opus 5\.5/ }));
});

test("the model's name opens the picker inside the same popover", async () => {
  await openThread();
  const popover = await openEffortControl();
  await userEvent.click(within(popover).getByRole("button", { name: "Change model: Opus 5.5" }));
  expect(await within(popover).findByRole("listbox", { name: "Models" })).toBeTruthy();
  expect(within(popover).queryByRole("slider")).toBeNull();
  await closeModelControl();
  // It opens on Tune again next time.
  const reopened = await openModelControl(/^Model: Opus 5\.5/);
  expect(await within(reopened).findByRole("slider", { name: "Effort" })).toBeTruthy();
});

test("picking a model lands on Tune at that model's levels, default effort and own speeds", async () => {
  await openNewThread();
  const popover = await openModelControl(/^Model: Opus 5\.5/);
  await pick(popover, "GPT-5 Codex", "Codex");
  const slider = await within(popover).findByRole("slider", { name: "Effort" });
  // Codex's four levels, on its default.
  expect(slider.getAttribute("aria-valuemax")).toBe("3");
  expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
  expect(within(popover).getByRole("button", { name: "Change model: GPT-5 Codex" })).toBeTruthy();
  const speed = within(popover).getByRole("radiogroup", { name: "Speed" });
  expect(
    within(speed)
      .getAllByRole("radio")
      .map((radio) => radio.ariaLabel),
  ).toEqual(["Standard", "Fast"]);
  expect(chipEffort()).toBe("Medium");
});

test("picking a model with no levels and no speeds closes the popover on it", async () => {
  await openNewThread();
  const popover = await openModelControl(/^Model: Opus 5\.5/);
  await pick(popover, "Big Pickle", "OpenCode");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Model and effort" })).toBeNull(),
  );
  expect(screen.getByRole("button", { name: /^Model: Big Pickle/ })).toBeTruthy();
});
