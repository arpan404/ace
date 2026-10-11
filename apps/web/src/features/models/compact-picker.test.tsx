import { replayCursor } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { closeModelControl, openModelControl, openModelPicker } from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

async function openCatalog(count = 9) {
  const app = harness();
  const sample = app.daemon.services.models.find(
    (model) =>
      model.provider === "claude" && model.instance === "claude-personal" && model.isDefault,
  );
  if (!sample) throw new Error("Missing personal Claude fixture");
  app.daemon.services.models.push(
    ...Array.from({ length: count }, (_, index) => ({
      ...sample,
      id: `shortcut-${index + 1}`,
      nativeModelId: `shortcut-${index + 1}`,
      displayName: `Shortcut model ${String(index + 1).padStart(3, "0")}`,
      isDefault: false,
      sortKey: `shortcut-${String(index + 1).padStart(3, "0")}`,
    })),
  );
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const popover = await openModelControl(/^Model: Opus 5\.5/);
  const list = await openModelPicker(popover);
  return { popover, list };
}

test.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
  "⌘%i selects that row in the filtered catalog",
  async (number) => {
    const { popover, list } = await openCatalog();
    await userEvent.type(
      within(popover).getByRole("combobox", { name: "Search models" }),
      "Shortcut model",
    );
    expect(within(list).getAllByRole("option")).toHaveLength(9);
    await userEvent.keyboard(`{Meta>}${number}{/Meta}`);
    expect(
      await screen.findByRole("button", {
        name: new RegExp(`^Model: Shortcut model ${String(number).padStart(3, "0")}, Personal`),
      }),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull());
  },
);

test("⌘1–9 leave the selected model alone after the searched picker closes", async () => {
  const { popover } = await openCatalog();
  await userEvent.type(
    within(popover).getByRole("combobox", { name: "Search models" }),
    "Shortcut model",
  );
  await closeModelControl();
  const modelName = screen
    .getByRole("button", { name: /^Model: Opus 5\.5, Personal/ })
    .getAttribute("aria-label");
  for (const number of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    await userEvent.keyboard(`{Meta>}${number}{/Meta}`);
    expect(
      screen
        .getByRole("button", { name: /^Model: Opus 5\.5, Personal/ })
        .getAttribute("aria-label"),
    ).toBe(modelName);
    expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull();
  }
});

test.each([55, 120])(
  "expanded legacy rows omit nonexistent controls targets in a virtual catalog with %i added models",
  async (count) => {
    const { popover, list } = await openCatalog(count);
    const search = within(popover).getByRole("combobox", { name: "Search models" });
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() =>
      expect(within(list).getByRole("option", { name: "Legacy models, 6" })).toBeTruthy(),
    );
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => {
      const active = document.getElementById(search.getAttribute("aria-activedescendant") ?? "");
      expect(active?.getAttribute("aria-label")).toMatch(/^Opus 5, /);
    });
    // Keep the disclosure in the rendered window, even without layout in jsdom.
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => {
      const toggle = within(list).getByRole("option", { name: "Legacy models, 6" });
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.getAttribute("aria-controls")).toBeNull();
    });
    await userEvent.keyboard("{ArrowDown}{ArrowLeft}");
    expect(
      within(list).getByRole("option", { name: "Legacy models, 6" }).getAttribute("aria-expanded"),
    ).toBe("false");
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(await screen.findByRole("button", { name: /^Model: Opus 5, Personal/ })).toBeTruthy();
  },
);

test("a nonvirtual legacy disclosure controls its actual labeled model region", async () => {
  const { list } = await openCatalog();
  const toggle = within(list).getByRole("option", { name: "Legacy models, 6" });
  await userEvent.click(toggle);
  const legacy = within(list).getByRole("group", { name: "Legacy models" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).toBe(legacy);
  expect(within(legacy).getByRole("option", { name: /^Opus 5, / })).toBeTruthy();
});

test("Tab reaches the account rail and arrows filter it before returning to search", async () => {
  const { popover, list } = await openCatalog();
  const search = within(popover).getByRole("combobox", { name: "Search models" });
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(
    within(popover).getByRole("tab", { name: "Claude Code · Personal" }),
  );
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(
    within(popover).getByRole("tab", { name: "Claude Code · Work", selected: true }),
  );
  expect(
    within(list).getByRole("option", { name: /^Sonnet 5\.5, Claude Code · Work/ }),
  ).toBeTruthy();
  expect(within(list).queryByRole("option", { name: /Shortcut model/ })).toBeNull();
  await userEvent.tab();
  expect(document.activeElement).toBe(search);
  // Searching still crosses the selected account/provider boundary.
  await userEvent.type(search, "Shortcut model 009");
  await userEvent.keyboard("{Enter}");
  expect(
    await screen.findByRole("button", { name: /^Model: Shortcut model 009, Personal/ }),
  ).toBeTruthy();
});

test("an unavailable search result explains its limit and refuses quick selection", async () => {
  const { popover, list } = await openCatalog();
  await userEvent.type(
    within(popover).getByRole("combobox", { name: "Search models" }),
    "GPT-6.2 Sol",
  );
  const row = within(list).getByRole("option", { name: /GPT-6\.2 Sol.*Team.*Limit reached/ });
  expect(row.getAttribute("aria-disabled")).toBe("true");
  await userEvent.keyboard("{Meta>}1{/Meta}{Enter}");
  expect(screen.getByRole("dialog", { name: "Choose model" })).toBe(popover);
  expect(screen.getByRole("button", { name: /^Model: Opus 5\.5, Personal/ })).toBeTruthy();
});

test("keyboard selection can reach models beyond the initial rendered window", async () => {
  const { popover, list } = await openCatalog(120);
  const search = within(popover).getByRole("combobox", { name: "Search models" });
  await userEvent.type(search, "Shortcut model");
  await userEvent.keyboard("{ArrowUp}");
  await waitFor(() => {
    const active = document.getElementById(search.getAttribute("aria-activedescendant") ?? "");
    expect(active?.getAttribute("aria-label")).toMatch(/^Shortcut model 120,/);
  });
  expect(within(list).queryByRole("option", { name: /^Shortcut model 060,/ })).toBeNull();
  await userEvent.keyboard("{Enter}");
  expect(
    await screen.findByRole("button", { name: /^Model: Shortcut model 120, Personal/ }),
  ).toBeTruthy();
});
