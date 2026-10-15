import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ModelControl } from "./model-control.tsx";
import type { ModelControlView } from "./control-view.ts";

const speeds = [
  { speed: "standard", name: "Standard", value: undefined },
  { speed: "fast", name: "Fast", value: "priority" },
  { speed: "ultrafast", name: "Ultrafast", value: "ultrafast" },
] as const;

const view: ModelControlView = {
  provider: undefined,
  label: "A very long model display name that yields to its capability indicators",
  placeholder: "Choose model",
  ariaLabel: "Model: long display name, High effort, fast",
  tip: "Full model identity · High effort · Fast",
  modelKey: "long",
  efforts: ["minimal", "low", "medium", "high", "ultra"],
  effort: "high",
  defaultEffort: "medium",
  effortDefault: false,
  effortReason: undefined,
  speeds,
  speed: "fast",
  speedReason: undefined,
  canReset: true,
  accounts: [],
  account: undefined,
  models: [],
  providers: [],
  catalog: "ready",
};

function draw(overrides: Partial<ModelControlView> = {}) {
  const actions = {
    onEffort: vi.fn(),
    onSpeed: vi.fn(),
    onModel: vi.fn(() => true),
    onAccount: vi.fn(),
  };
  render(
    <ModelControl view={{ ...view, ...overrides }} actions={actions} compact className="flex" />,
  );
  return { chip: screen.getByRole("button", { name: view.ariaLabel }), actions };
}

test("one chip shows the model, its effort and its speed, with no separate effort chip", () => {
  const { chip } = draw();
  expect(chip.textContent).toContain(view.label);
  expect(chip.querySelector("[data-slot=model-effort]")?.textContent).toBe("High");
  expect(within(chip).getByRole("img", { name: "Fast" })).toBeTruthy();
  expect(screen.getAllByRole("button")).toEqual([chip]);
});

test("a compact chip names the effort briefly, so the model's name keeps its room", () => {
  const { chip } = draw({ effort: "medium" });
  expect(chip.querySelector("[data-slot=model-effort]")?.textContent).toBe("Med");
});

test("standard speed shows no speed icon on the chip", () => {
  const { chip } = draw({ speed: "standard" });
  expect(within(chip).queryByRole("img", { name: /fast/i })).toBeNull();
});

test("ultrafast shows its own icon on the chip", () => {
  const { chip } = draw({ speed: "ultrafast" });
  expect(within(chip).getByRole("img", { name: "Ultrafast" })).toBeTruthy();
});

test("an unknown provider default omits effort without inventing a level", () => {
  const { chip } = draw({ effort: undefined });
  expect(chip.querySelector("[data-slot=model-effort]")).toBeNull();
  expect(chip.textContent).not.toContain("Default");
});

test("the chip's effort opens Tune: speed, effort and the model's levels with its default marked", async () => {
  const { chip, actions } = draw();
  await userEvent.click(within(chip).getByText("High"));
  const popover = await screen.findByRole("dialog", { name: "Model and effort" });
  const slider = await within(popover).findByRole("slider", { name: "Effort" });
  expect(slider.getAttribute("aria-valuetext")).toBe("High");
  expect(slider.getAttribute("aria-valuemax")).toBe("4");
  expect(slider.querySelectorAll("[data-default]")).toHaveLength(1);
  // The ring names the default for assistive tech too.
  const described = document.getElementById(slider.getAttribute("aria-describedby") ?? "");
  expect(described?.textContent).toContain("The model's default is Medium.");
  const speed = within(popover).getByRole("radiogroup", { name: "Speed" });
  expect(
    within(speed)
      .getAllByRole("radio")
      .map((radio) => radio.ariaLabel),
  ).toEqual(["Standard", "Fast", "Ultrafast"]);
  expect(within(speed).getByRole("radio", { name: "Fast" }).ariaChecked).toBe("true");
  await userEvent.click(within(speed).getByRole("radio", { name: "Ultrafast" }));
  expect(actions.onSpeed).toHaveBeenCalledWith("ultrafast");
});

test.each([
  {
    model: "Claude Opus",
    view: {
      label: "Opus 5.5",
      efforts: ["low", "medium", "high"],
      effort: "medium",
      speeds: [],
      speed: "standard",
    },
  },
  {
    model: "Codex",
    view: {
      label: "GPT-6.1",
      efforts: ["minimal", "low", "medium", "high"],
      effort: "medium",
      speed: "standard",
    },
  },
] satisfies { model: string; view: Partial<ModelControlView> }[])(
  "one click anywhere on a $model chip opens the effort slider first, its name included",
  async ({ view: overrides }) => {
    const { chip } = draw(overrides);
    const name = chip.querySelector("[data-slot=model-name]");
    const caret = chip.querySelector("[data-model-tune] svg:last-child");
    const effort = chip.querySelector("[data-slot=model-effort]");
    if (!name || !caret || !effort) throw new Error("The chip has no name, effort or caret");
    for (const target of [name, effort, caret]) {
      await userEvent.click(target);
      const popover = await screen.findByRole("dialog", { name: "Model and effort" });
      const slider = await within(popover).findByRole("slider", { name: "Effort" });
      expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  },
);

test("a model with a single speed has no speed segment", async () => {
  const { chip } = draw({ speeds: [], speed: "standard" });
  await userEvent.click(within(chip).getByText("High"));
  const popover = await screen.findByRole("dialog", { name: "Model and effort" });
  await within(popover).findByRole("slider", { name: "Effort" });
  expect(within(popover).queryByRole("radiogroup", { name: "Speed" })).toBeNull();
});

test("a pending switch prioritizes the target and keeps the former model in its description", () => {
  const { chip } = draw({
    switching: {
      from: "Another enormous former model name",
      description: "From former model on the next turn",
    },
  });
  expect(chip.textContent).toContain(view.label);
  expect(chip.textContent).not.toContain("Another enormous former model name");
  expect(chip.getAttribute("aria-description")).toBe("From former model on the next turn");
});

test("the full identity survives offline and pending-switch tooltip context", async () => {
  const { chip } = draw({
    offline: "Offline",
    switching: { from: "Former full model", description: "On the next turn" },
  });
  await userEvent.hover(chip);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain(view.tip);
  expect(tooltip.textContent).toContain("Offline");
  expect(tooltip.textContent).toContain("Previously Former full model");
});
