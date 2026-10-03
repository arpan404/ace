import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { fakeBackend } from "@/features/more/fake-backend.ts";
import { harness } from "@/test/harness.tsx";

const card = (name: string) => screen.findByRole("article", { name });

test("each account shows its quota windows, and the exhausted one says when it resets", async () => {
  await harness().open("/more/accounts");

  const personal = await card("Claude Code Personal");
  const fiveHour = within(personal).getByRole("meter", { name: "5-hour window" });
  expect(fiveHour.getAttribute("aria-valuenow")).toBe("62");
  expect(within(personal).getByText("Default")).toBeTruthy();

  const team = await card("Codex Team");
  expect(within(team).getByText("Limit reached")).toBeTruthy();
  expect(
    within(team).getByRole("meter", { name: "5-hour window" }).getAttribute("aria-valuenow"),
  ).toBe("100");
  expect(
    within(team).getByText(/3 threads are paused until the window resets at \d\d:\d\d/),
  ).toBeTruthy();
});

test("Move running threads moves an exhausted account's threads to the account with headroom", async () => {
  await harness().open("/more/accounts");
  const team = await card("Codex Team");

  await userEvent.click(within(team).getByRole("button", { name: "Move running threads" }));

  expect(await screen.findByText("Moved 3 threads to Codex · Personal")).toBeTruthy();
  await waitFor(() =>
    expect(within(team).queryByRole("button", { name: "Move running threads" })).toBeNull(),
  );
  expect(within(await card("Codex Personal")).getByText("5 running threads")).toBeTruthy();
});

test("the run-out policy and headroom switch are kept when you come back", async () => {
  const app = harness();
  await app.open("/more/accounts");
  const policy = await screen.findByRole("radiogroup", { name: "When an account runs out" });

  await userEvent.click(within(policy).getByRole("radio", { name: /Pause the thread/ }));
  await userEvent.click(screen.getByRole("switch", { name: "Keep headroom" }));
  await userEvent.click(screen.getByRole("link", { name: /Files/ }));
  await screen.findByRole("heading", { level: 1, name: "Files" });
  await userEvent.click(screen.getByRole("link", { name: /Usage & accounts/ }));

  const again = await screen.findByRole("radiogroup", { name: "When an account runs out" });
  await waitFor(() =>
    expect(
      within(again)
        .getByRole("radio", { name: /Pause the thread/ })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  expect(screen.getByRole("switch", { name: "Keep headroom" }).getAttribute("aria-checked")).toBe(
    "false",
  );
});

test("Refresh picks up quota the providers reported since the page opened", async () => {
  const app = harness();
  await app.open("/more/accounts");
  const work = await card("Claude Code Work");
  expect(
    within(work).getByRole("meter", { name: "5-hour window" }).getAttribute("aria-valuenow"),
  ).toBe("23");

  const backend = await fakeBackend(app.client);
  const window = backend.accounts
    .find((account) => account.id === "claude-work")
    ?.windows.find((w) => w.id === "five-hour");
  if (!window) throw new Error("missing the Work 5-hour window");
  window.usedPercent = 47;
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

  await waitFor(async () =>
    expect(
      within(await card("Claude Code Work"))
        .getByRole("meter", { name: "5-hour window" })
        .getAttribute("aria-valuenow"),
    ).toBe("47"),
  );
});

test("usage shows a bar per day of the chosen range and totals by model", async () => {
  await harness().open("/more/accounts");
  const days = await screen.findByRole("list", { name: "Tokens per day" });
  await waitFor(() => expect(within(days).getAllByRole("listitem")).toHaveLength(14));

  await userEvent.click(screen.getByRole("button", { name: "7 days" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Tokens per day" })).getAllByRole("listitem"),
    ).toHaveLength(7),
  );
  const table = screen.getByRole("table", { name: "Usage by model" });
  const models = within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
  expect(models[0]).toBe("claude-opus-4-6");
  expect(models).toHaveLength(4);
});

test("Add account explains how to sign in a second account without giving ace credentials", async () => {
  await harness().open("/more/accounts");
  await userEvent.click(await screen.findByRole("button", { name: "Add account" }));
  const dialog = await screen.findByRole("dialog", { name: "Add an account" });
  expect(within(dialog).getByLabelText("Sign-in command").textContent).toContain(
    "CLAUDE_CONFIG_DIR=",
  );

  await userEvent.click(within(dialog).getByRole("button", { name: "Codex" }));

  expect(within(dialog).getByLabelText("Sign-in command").textContent).toBe(
    "CODEX_HOME=~/.codex-team codex login",
  );
});
