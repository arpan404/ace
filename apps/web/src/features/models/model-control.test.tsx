import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ModelControl } from "./model-control.tsx";
import type { ModelControlView } from "./control-view.ts";

const view: ModelControlView = {
  provider: undefined,
  label: "A very long model display name that yields to its capability indicators",
  placeholder: "Choose model",
  ariaLabel: "Model: long display name, High effort, fast",
  tip: "Full model identity · High effort · Fast",
  modelKey: "long",
  efforts: ["minimal", "low", "medium", "high", "xhigh"],
  effort: "high",
  effortDefault: false,
  effortReason: undefined,
  fast: true,
  fastReason: undefined,
  canReset: true,
  accounts: [],
  account: undefined,
  models: [],
  providers: [],
  catalog: "ready",
};
const actions = {
  onEffort: vi.fn(),
  onFast: vi.fn(),
  onReset: vi.fn(),
  onModel: vi.fn(() => true),
  onAccount: vi.fn(),
};

function draw(overrides: Partial<ModelControlView> = {}) {
  render(
    <ModelControl view={{ ...view, ...overrides }} actions={actions} compact className="flex" />,
  );
  return screen.getByRole("button", { name: view.ariaLabel });
}

test("compact controls keep effort in its own chip while the model name yields space", () => {
  const control = draw();
  const signal = within(screen.getByRole("button", { name: "Reasoning: High" })).getByRole("img", {
    name: "High reasoning",
  });
  expect(signal.textContent).toBe("High");
  expect(control.getAttribute("aria-label")).toContain("fast");
});

test("an unknown provider default omits effort without inventing a level", () => {
  const control = draw({ effort: undefined });
  expect(within(control).queryByRole("img", { name: /reasoning/ })).toBeNull();
  expect(control.textContent).not.toContain("Default");
  expect(screen.getByRole("button", { name: "Reasoning: Select effort" })).toBeTruthy();
});

test("a reported default keeps its full tooltip and short label", () => {
  draw({
    efforts: ["low", "medium", "high"],
    effort: "medium",
    effortDefault: true,
  });
  expect(
    within(screen.getByRole("button", { name: "Reasoning: Medium" })).getByRole("img", {
      name: "Medium reasoning · default",
    }).textContent,
  ).toBe("Med");
});

test.each([{ efforts: [] }])("zero reported efforts omits the effort chip (%j)", ({ efforts }) => {
  draw({ efforts });
  expect(screen.queryByRole("button", { name: /^Reasoning: / })).toBeNull();
});

test("a pending switch prioritizes the target and keeps the former model in its description", () => {
  const control = draw({
    switching: {
      from: "Another enormous former model name",
      description: "From former model on the next turn",
    },
  });
  expect(control.textContent).toContain(view.label);
  expect(control.textContent).not.toContain("Another enormous former model name");
  expect(control.getAttribute("aria-description")).toBe("From former model on the next turn");
});

test("the full identity survives offline and pending-switch tooltip context", async () => {
  const control = draw({
    offline: "Offline",
    switching: { from: "Former full model", description: "On the next turn" },
  });
  await userEvent.hover(control);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain(view.tip);
  expect(tooltip.textContent).toContain("Offline");
  expect(tooltip.textContent).toContain("Previously Former full model");
});
