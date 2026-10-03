import { expect, test } from "@playwright/test";

/** The server queue and limit recovery in fake mode, served by @ace/fake-daemon. */
test("Send now steers a queued message into the running turn", async ({ page }) => {
  await page.goto("/t/thread-replay-cursor");
  const message = page.getByRole("combobox", { name: "Message" });
  await message.fill("Also check the iOS cold-start path");
  await message.press("Enter");
  const queue = page.getByRole("list", { name: "Queued messages" });
  await expect(queue.getByRole("listitem")).toHaveCount(1);

  await page
    .getByRole("button", { name: "Queued message options: Also check the iOS cold-start path" })
    .click();
  await page.getByRole("menuitem", { name: "Send now" }).click();

  await expect(queue).toHaveCount(0);
  await expect(
    page.getByRole("feed", { name: "Transcript" }).getByText("Also check the iOS cold-start path"),
  ).toBeVisible();
});

test("a limited thread moves to another account and carries on", async ({ page }) => {
  await page.goto("/t/thread-limit-search");
  const limit = page.getByRole("region", { name: "Usage limit reached" });
  await expect(limit).toBeVisible();
  await expect(page.getByRole("button", { name: "Model: GPT-5 Codex, team" })).toBeVisible();

  await limit.getByRole("button", { name: "Move to another account" }).click();

  await expect(limit).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Model: GPT-5 Codex, (?!team)/ })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Threads" })
      .getByRole("link", { name: /Rank workspace search by recent edits/ }),
  ).not.toContainText("Limited");
});

test("Usage & accounts moves every thread stopped at an account's limit", async ({ page }) => {
  await page.goto("/more/accounts");
  const team = page.getByRole("article", { name: "Codex Team" });
  await expect(team).toContainText("3 threads are paused until the window resets");

  await team.getByRole("button", { name: "Move running threads" }).click();

  await expect(page.getByText("Moved 3 threads to Codex · Personal")).toBeVisible();
  await expect(team.getByRole("button", { name: "Move running threads" })).toHaveCount(0);
  const threads = page.getByRole("navigation", { name: "Threads" });
  await page.getByRole("link", { name: "Home" }).click();
  await expect(threads.getByRole("link", { name: /Split the CI matrix/ })).not.toContainText(
    "Limited",
  );
});
