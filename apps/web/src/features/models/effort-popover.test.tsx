import { replayCursor } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import {
  chooseEffort,
  closeModelControl,
  openEffortControl,
  openModelControl,
} from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

async function open() {
  const app = harness();
  app.daemon.services.models = app.daemon.services.models.map((model) =>
    model.provider === "claude"
      ? { ...model, efforts: ["light", "medium", "high", "ultra"], defaultEffort: "medium" }
      : model,
  );
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  return app;
}

test("the effort slider snaps to reported levels with arrows, Home and End, then resets to the default", async () => {
  await open();
  const popover = await openEffortControl();
  const slider = within(popover).getByRole("slider", { name: "Effort" });
  expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
  await chooseEffort(popover, "{End}");
  expect(slider.getAttribute("aria-valuetext")).toBe("Ultra");
  expect(screen.getByRole("button", { name: "Reasoning: Ultra" }).textContent).toBe("Ultra");
  await userEvent.keyboard("{ArrowLeft}");
  expect(slider.getAttribute("aria-valuetext")).toBe("High");
  await userEvent.keyboard("{Home}");
  expect(slider.getAttribute("aria-valuetext")).toBe("Light");
  await userEvent.keyboard("{ArrowRight}");
  expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
  await userEvent.keyboard("{End}");
  await userEvent.click(within(popover).getByRole("button", { name: "Reset effort" }));
  expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Effort and speed" })).toBeNull(),
  );
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reasoning: Medium" }));
});

test("the model link opens the compact picker and the model picker has no effort footer", async () => {
  await open();
  const effort = await openEffortControl();
  await userEvent.click(within(effort).getByRole("button", { name: "Change model: Opus 5.5" }));
  const picker = await screen.findByRole("dialog", { name: "Choose model" });
  expect(await within(picker).findByRole("listbox", { name: "Models" })).toBeTruthy();
  expect(within(picker).queryByRole("slider")).toBeNull();
  expect(within(picker).queryByRole("button", { name: "Reset effort" })).toBeNull();
  await closeModelControl();
  const reopened = await openModelControl(/^Model: Opus 5\.5/);
  expect(await within(reopened).findByRole("listbox", { name: "Models" })).toBeTruthy();
});
