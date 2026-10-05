import { replayCursor } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { closeModelControl, openModelControl, openModelPicker } from "@/test/model-control.ts";

beforeEach(() => localStorage.clear());

/** A Claude Code thread mid-turn, with its model picker open. */
async function openPicker() {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const popover = await openModelControl(/^Model: Opus 4\.1/);
  const list = await openModelPicker(popover);
  return { app, popover, list };
}
const names = (list: HTMLElement) =>
  within(list)
    .getAllByRole("option")
    .map((option) => option.getAttribute("aria-label"));

test("the picker opens on the thread's provider, current models first and legacy ones last", async () => {
  const { popover, list } = await openPicker();
  expect(within(popover).getByRole("tab", { name: "Claude Code" }).ariaSelected).toBe("true");
  expect(names(list)).toEqual([
    "Opus 4.1, Claude Code",
    "Sonnet 4.5, Claude Code",
    "Haiku 4.5, Claude Code",
    "Opus 4, Claude Code",
  ]);
  const legacy = within(list).getByRole("group", { name: "Legacy models" });
  expect(within(legacy).getByRole("option").getAttribute("aria-label")).toBe("Opus 4, Claude Code");
  expect(
    within(list).getByRole("option", { name: "Sonnet 4.5, Claude Code" }).textContent,
  ).toContain("NEW");
  expect(within(list).getByRole("option", { name: "Opus 4.1, Claude Code" }).ariaSelected).toBe(
    "true",
  );
});

test("the provider column switches the list, and a provider that isn't installed is dimmed", async () => {
  const { popover, list } = await openPicker();
  await userEvent.click(within(popover).getByRole("tab", { name: "Codex" }));
  expect(names(list)).toEqual(["GPT-5 Codex, Codex", "GPT-5, Codex"]);

  const pi = within(popover).getByRole("tab", { name: "Pi" });
  expect(pi.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(pi);
  expect(within(popover).getByRole("tab", { name: "Codex" }).ariaSelected).toBe("true");
});

test("search finds models across every provider", async () => {
  const { popover, list } = await openPicker();
  const search = within(popover).getByRole("combobox", { name: "Search models" });
  await userEvent.type(search, "gpt");
  expect(names(list)).toEqual(["GPT-5 Codex, Codex", "GPT-5, Codex"]);
  await userEvent.clear(search);
  await userEvent.type(search, "sonnet");
  expect(names(list)).toEqual(["Sonnet 4.5, Claude Code", "Sonnet 4.5 (OpenCode), OpenCode"]);
  await userEvent.type(search, "zzz");
  expect(within(popover).getByText("No models match “sonnetzzz”")).toBeTruthy();
});

test("a starred model is kept under Favorites, also the next time the picker opens", async () => {
  const { popover, list } = await openPicker();
  await userEvent.click(within(list).getByRole("button", { name: "Add Haiku 4.5 to favorites" }));
  await userEvent.click(within(popover).getByRole("tab", { name: "Codex" }));
  await userEvent.click(within(list).getByRole("button", { name: "Add GPT-5 to favorites" }));
  await closeModelControl();

  const again = await openModelPicker(await openModelControl(/^Model: Opus 4\.1/));
  await userEvent.click(screen.getByRole("tab", { name: "Favorites" }));
  expect(names(again)).toEqual(["Haiku 4.5, Claude Code", "GPT-5, Codex"]);
  await userEvent.click(
    within(again).getByRole("button", { name: "Remove Haiku 4.5 from favorites" }),
  );
  expect(names(again)).toEqual(["GPT-5, Codex"]);
});

test("⌘ and a number pick that row, and the popover comes back to its effort", async () => {
  const { popover } = await openPicker();
  await userEvent.keyboard("{Meta>}2{/Meta}");
  expect(await screen.findByRole("button", { name: /^Model: Sonnet 4\.5, personal/ })).toBeTruthy();
  expect(
    await within(popover).findByRole("button", { name: "Change model: Sonnet 4.5" }),
  ).toBeTruthy();
});

test("arrows move through the list from the search field and Enter picks", async () => {
  const { popover } = await openPicker();
  const search = within(popover).getByRole("combobox", { name: "Search models" });
  expect(document.activeElement).toBe(search);
  await userEvent.keyboard("{ArrowDown}{ArrowDown}");
  expect(search.getAttribute("aria-activedescendant")).toBe(
    within(popover).getByRole("option", { name: "Haiku 4.5, Claude Code" }).id,
  );
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Model: Haiku 4\.5, personal/ })).toBeTruthy(),
  );
});

test("the provider column moves with the arrow keys", async () => {
  const { popover, list } = await openPicker();
  within(popover).getByRole("tab", { name: "Claude Code" }).focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(within(popover).getByRole("tab", { name: "Codex" }));
  expect(names(list)).toEqual(["GPT-5 Codex, Codex", "GPT-5, Codex"]);
});

test("Escape clears a search first, then closes the popover", async () => {
  const { popover, list } = await openPicker();
  const search = within(popover).getByRole("combobox", { name: "Search models" });
  await userEvent.type(search, "gpt");
  await userEvent.keyboard("{Escape}");
  expect((search as HTMLInputElement).value).toBe("");
  expect(names(list)).toContain("Opus 4.1, Claude Code");
  expect(screen.getByRole("dialog", { name: "Model and effort" })).toBe(popover);
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Model and effort" })).toBeNull(),
  );
});

type Harness = ReturnType<typeof harness>;

/**
 * Intercepts `models.list`: `hold` keeps every reply back until the returned release is called;
 * `refreshing` answers at once but says discovery is still refreshing the first model's provider.
 */
function interceptCatalog(app: Harness, mode: "hold" | "refreshing") {
  const services = app.daemon.services;
  const handle = services.handle.bind(services);
  const held: (() => void)[] = [];
  services.handle = (message, push) => {
    if (message.type !== "models.list") return handle(message, push);
    if (mode === "hold") {
      held.push(() => handle(message, push));
      return true;
    }
    return handle(message, (reply) => {
      if (reply.type !== "models.result" || !("models" in reply.result)) return push(reply);
      const first = reply.result.models[0];
      const instances = first
        ? [{ provider: first.provider, instance: first.instance, stale: true, refreshing: true }]
        : [];
      push({ ...reply, result: { ...reply.result, instances } });
    });
  };
  return () => {
    for (const release of held.splice(0)) release();
  };
}

async function openThread(app: Harness) {
  app.play(replayCursor()).runThrough("finding");
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
}

test("while the catalog is still arriving the picker shows it is loading, then the models", async () => {
  const app = harness();
  const release = interceptCatalog(app, "hold");
  await openThread(app);
  // Until the catalog arrives the chip shows what the thread recorded.
  const popover = await openModelControl(/^Model: /);
  const list = await openModelPicker(popover);
  expect(within(list).getByRole("status", { name: "Loading models" })).toBeTruthy();
  expect(within(list).queryByText("No models")).toBeNull();

  release();
  expect(await within(list).findByRole("option", { name: "Opus 4.1, Claude Code" })).toBeTruthy();
  expect(within(list).queryByRole("status", { name: "Loading models" })).toBeNull();
});

test("a catalog the daemon is still refreshing lists its models and says it is refreshing", async () => {
  const app = harness();
  interceptCatalog(app, "refreshing");
  await openThread(app);
  const popover = await openModelControl(/^Model: Opus 4\.1/);
  const list = await openModelPicker(popover);
  expect(await within(list).findByRole("option", { name: "Opus 4.1, Claude Code" })).toBeTruthy();
  expect(within(popover).getByRole("status", { name: "Refreshing models" })).toBeTruthy();
});
