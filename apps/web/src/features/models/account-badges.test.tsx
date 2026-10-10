import { replayCursor, workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import {
  closeModelControl,
  openModelControl,
  openModelPicker,
  selectAccount,
} from "@/test/model-control.ts";
import { openProfileMenu } from "@/test/navigation.ts";

beforeEach(() => localStorage.clear());
const thread = "thread-replay-cursor";
async function open(app: ReturnType<typeof harness>) {
  const scenario = replayCursor();
  app
    .play({
      ...scenario,
      thread: {
        ...scenario.thread,
        live: { account: "claude-personal", model: "claude-opus-5-5" },
      },
    })
    .runThrough("finding");
  await app.open(`/t/${thread}`);
  const popover = await openModelControl();
  const list = await openModelPicker(popover);
  return { popover, list };
}

test("a single account has no dot in its composer, row or picker", async () => {
  const app = harness();
  app.daemon.services.accounts = app.daemon.services.accounts.filter(
    (account) => account.provider !== "claude" || account.id === "claude-personal",
  );
  app.daemon.services.models = app.daemon.services.models.filter(
    (model) => model.provider !== "claude" || model.instance === "claude-personal",
  );
  const { popover } = await open(app);
  const rail = within(popover).getByRole("tablist", { name: "Model sources" });
  const personal = await within(rail).findByRole("tab", { name: "Claude Code", selected: true });
  expect(within(personal).queryByRole("img", { name: "Personal account" })).toBeNull();
  expect(
    within(screen.getByRole("button", { name: /^Model: Opus 5.5, Personal/ })).queryByRole("img", {
      name: "Personal account",
    }),
  ).toBeNull();
  expect(
    within(screen.getByRole("link", { name: /Replay cursor resets/ })).queryByTitle(
      "Personal account",
    ),
  ).toBeNull();
  await closeModelControl();
});

test("each provider has one rail entry and selecting an account switches its catalog", async () => {
  const app = harness();
  const team = app.daemon.services.accounts.find((account) => account.id === "codex-team");
  if (!team) throw new Error("Missing team account");
  team.quota.windows = {};
  team.isDefault = true;
  for (const account of app.daemon.services.accounts)
    if (account.provider === "codex" && account !== team) account.isDefault = false;
  const { popover, list } = await open(app);
  const rail = within(popover).getByRole("tablist", { name: "Model sources" });
  expect(within(rail).getAllByRole("tab", { name: "Codex" })).toHaveLength(1);
  await userEvent.click(within(rail).getByRole("tab", { name: "Codex" }));
  expect(within(list).getByRole("option", { name: /^GPT-6\.2 Sol/ })).toBeTruthy();
  await selectAccount(popover, "Personal");
  expect(within(list).getByRole("option", { name: /^GPT-6 Luna/ })).toBeTruthy();
  expect(within(list).queryByRole("option", { name: /^GPT-6\.2 Sol/ })).toBeNull();
  await selectAccount(popover, "Team");
  expect(within(list).getByRole("option", { name: /^GPT-6\.2 Sol/ })).toBeTruthy();
});

test("choosing a model on another account updates the composer and its row's details", async () => {
  const { popover, list } = await open(harness());
  await selectAccount(popover, "Work");
  await userEvent.click(within(list).getByRole("option", { name: /^Sonnet 5.5/ }));
  const chip = await screen.findByRole("button", { name: /^Model: Sonnet 5.5, Work/ });
  expect(within(chip).getByRole("img", { name: "Claude Code · Work" })).toBeTruthy();
  const row = screen.getByRole("link", { name: /Replay cursor resets/ });
  await userEvent.hover(row);
  const details = await screen.findByLabelText(/^Details for Replay cursor resets/);
  expect(within(details).getByText("Claude Code · Work (queued)")).toBeTruthy();
});

test("editing an account label updates its composer, thread row, picker, search and usage header", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  const scenario = replayCursor();
  app
    .play({
      ...scenario,
      thread: {
        ...scenario.thread,
        live: { account: "claude-personal", model: "claude-opus-5-5" },
      },
    })
    .runThrough("finding");
  await app.open("/settings/providers/claude");
  const accounts = await screen.findByRole("list", { name: "Claude Code accounts" });
  await userEvent.click(within(accounts).getByRole("button", { name: "Manage Personal" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit label…" }));
  const editor = screen.getByRole("form", { name: "Edit account label" });
  const name = within(editor).getByRole("textbox", { name: "Account name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Studio");
  const label = within(editor).getByRole("textbox", { name: "Short label" });
  await userEvent.clear(label);
  await userEvent.type(label, "ST");
  await userEvent.click(within(editor).getByRole("combobox", { name: "Label colour" }));
  await userEvent.click(await screen.findByRole("option", { name: "Violet" }));
  await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
  await within(accounts).findByRole("img", { name: "Claude Code · Studio" });
  await userEvent.click(await screen.findByRole("link", { name: "Back to app" }));
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  await openProfileMenu();
  await userEvent.click(await screen.findByRole("menuitem", { name: "Usage & accounts" }));
  await waitFor(() =>
    expect(screen.getByRole("article", { name: "Claude Code Studio" })).toBeTruthy(),
  );
  await userEvent.click(await screen.findByRole("link", { name: /Replay cursor resets/ }));
  const chip = await screen.findByRole("button", { name: /^Model: Opus 5.5, Studio/ });
  expect(within(chip).getByRole("img", { name: "Claude Code · Studio" })).toBeTruthy();
  const row = screen.getByRole("link", { name: /Replay cursor resets/ });

  await userEvent.hover(row);
  const details = await screen.findByLabelText(/^Details for Replay cursor resets/);
  expect(within(details).getByText("Claude Code · Studio")).toBeTruthy();
  expect(within(details).queryByText("Claude Code · Personal")).toBeNull();
  await userEvent.unhover(row);
  const popover = await openModelControl();
  const list = await openModelPicker(popover);
  expect(within(popover).getByRole("combobox", { name: "Account" }).textContent).toContain(
    "Studio",
  );
  await userEvent.type(within(popover).getByRole("combobox", { name: "Search models" }), "Studio");
  expect(await within(list).findByRole("option", { name: /Opus 5.5.*Studio/ })).toBeTruthy();
  await closeModelControl();
  await userEvent.click(screen.getByRole("button", { name: /, account/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /Usage.*accounts/ }));
  await waitFor(() =>
    expect(screen.getByRole("article", { name: "Claude Code Studio" })).toBeTruthy(),
  );
});

test("account badges accept a complete emoji and reject more than two text characters", async () => {
  const app = harness();
  await app.open("/settings/providers/claude");
  const accounts = await screen.findByRole("list", { name: "Claude Code accounts" });
  await userEvent.click(within(accounts).getByRole("button", { name: "Manage Personal" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Edit label…" }));
  const form = within(screen.getByRole("form", { name: "Edit account label" }));
  const badge = form.getByRole("textbox", { name: "Short label" });
  await userEvent.clear(badge);
  await userEvent.type(badge, "ABC");
  expect(form.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  expect(form.getByText("Use up to two characters or one emoji.")).toBeTruthy();
  await userEvent.clear(badge);
  await userEvent.type(badge, "👩‍💻");
  expect(badge).toHaveProperty("value", "👩‍💻");
  await userEvent.click(form.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.queryByRole("form", { name: "Edit account label" })).toBeNull(),
  );
  const saved = await app.client.request({ type: "accounts.list" });
  expect(saved.accounts.find((account) => account.id === "claude-personal")?.shortLabel).toBe("👩‍💻");
});
