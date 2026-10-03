import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

async function goTo(page: string) {
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "Settings pages" })).getByRole("link", {
      name: page,
    }),
  );
}

async function pick(select: string, option: string) {
  await userEvent.click(await screen.findByRole("combobox", { name: select }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

test("a switched-off General setting stays off after leaving the page and coming back", async () => {
  await harness().open("/settings/general");
  const worktree = await screen.findByRole("switch", { name: "New threads use a worktree" });
  expect(worktree.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(worktree);

  await goTo("Notifications");
  await screen.findByRole("switch", { name: "Thread done" });
  await goTo("General");
  expect(
    (await screen.findByRole("switch", { name: "New threads use a worktree" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("false");
});

test("the default provider lists only installed, signed-in CLIs and remembers the choice", async () => {
  await harness().open("/settings/general");
  const select = await screen.findByRole("combobox", { name: "Default provider for new threads" });
  await waitFor(() => expect(select.textContent).toContain("Claude Code"));
  await userEvent.click(select);
  const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
  expect(options).toEqual(["Claude Code", "Codex", "OpenCode", "Cursor", "Gemini CLI"]);
  await userEvent.click(screen.getByRole("option", { name: "Codex" }));

  await goTo("Keyboard");
  await goTo("General");
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Default provider for new threads" }).textContent,
    ).toContain("Codex"),
  );
});

test("quiet hours turn on with a default window and accept a new start time", async () => {
  await harness().open("/settings/notifications");
  await userEvent.click(await screen.findByRole("switch", { name: "Quiet hours" }));
  expect(screen.getByText("22:00 to 08:00. Needs-you items still reach your phone.")).toBeTruthy();

  // Time fields report whole values, never partial keystrokes.
  fireEvent.change(screen.getByLabelText("Quiet hours start"), { target: { value: "23:30" } });
  expect(screen.getByText("23:30 to 08:00. Needs-you items still reach your phone.")).toBeTruthy();

  await userEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
  expect(screen.queryByLabelText("Quiet hours start")).toBeNull();
});

test("sound can be silenced", async () => {
  await harness().open("/settings/notifications");
  await screen.findByRole("switch", { name: "Needs you" });
  await pick("Sound", "None");
  await goTo("General");
  await goTo("Notifications");
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Sound" }).textContent).toContain("None"),
  );
});

test("Advanced thresholds persist and Reset restores every default", async () => {
  await harness().open("/settings/advanced");
  await pick("Unresponsive after", "15 minutes");
  await pick("Keep event logs", "Forever");
  expect(screen.getByRole("combobox", { name: "Keep event logs" }).textContent).toContain(
    "Forever",
  );

  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  await userEvent.click(await screen.findByRole("button", { name: "Reset settings" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Unresponsive after" }).textContent).toContain(
      "5 minutes",
    ),
  );
  expect(screen.getByRole("combobox", { name: "Keep event logs" }).textContent).toContain(
    "30 days",
  );
});

test("the Theme editor is reached from Advanced and keeps Advanced selected in the nav", async () => {
  await harness().open("/settings/advanced");
  await userEvent.click(await screen.findByRole("link", { name: "Open theme editor" }));
  await screen.findByRole("heading", { name: "Theme editor" });
  const nav = screen.getByRole("navigation", { name: "Settings pages" });
  expect(within(nav).getByRole("link", { name: "Advanced" }).getAttribute("aria-current")).toBe(
    "page",
  );
  await userEvent.click(screen.getByRole("link", { name: "Advanced", current: false }));
  await screen.findByRole("heading", { name: "Advanced" });
});
