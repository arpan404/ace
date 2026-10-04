import { screen, waitFor, within } from "@testing-library/react";
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
  await screen.findByText(/set in the ace desktop app/);
  await goTo("General");
  expect(
    (await screen.findByRole("switch", { name: "New threads use a worktree" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("false");
});

test("follow-ups and restart recovery are stored on the daemon", async () => {
  const app = harness();
  await app.open("/settings/general");
  await pick("Messages sent while the agent works", "Steer");
  await userEvent.click(
    await screen.findByRole("switch", { name: "Continue threads after a restart" }),
  );
  await waitFor(() => {
    expect(app.daemon.services.settings.get("threads.followUpBehavior")).toBe("steer");
    expect(app.daemon.services.settings.get("threads.continueAfterRestart")).toBe(true);
  });

  await goTo("Notifications");
  await goTo("General");
  expect(
    (await screen.findByRole("combobox", { name: "Messages sent while the agent works" }))
      .textContent,
  ).toContain("Steer");
});

test("when done threads settle is set in General and stored on the daemon", async () => {
  const app = harness();
  await app.open("/settings/general");
  expect(await screen.findByText(/Threads that need you never settle/)).toBeTruthy();
  await pick("Settle done threads", "After a week");
  await waitFor(() =>
    expect(app.daemon.services.settings.get("threads.autoSettleAfter")).toBe("1w"),
  );
  await pick("Settle done threads", "Never");
  await waitFor(() =>
    expect(app.daemon.services.settings.get("threads.autoSettleAfter")).toBe("never"),
  );
});

test("the default provider lists the installed CLIs and remembers the choice", async () => {
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

test("Advanced thresholds persist and Reset restores every default", async () => {
  await harness().open("/settings/advanced");
  await pick("Unresponsive after", "15 minutes");
  expect(screen.getByRole("combobox", { name: "Unresponsive after" }).textContent).toContain(
    "15 minutes",
  );

  await userEvent.click(screen.getByRole("button", { name: "Reset" }));
  await userEvent.click(await screen.findByRole("button", { name: "Reset settings" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Unresponsive after" }).textContent).toContain(
      "5 minutes",
    ),
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
