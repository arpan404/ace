import { expect, test } from "@playwright/test";

/** The server queue and limit recovery in fake mode, served by @ace/fake-daemon. */
test("Send now steers a queued message into the running turn", async ({ page }) => {
  await page.goto("/t/thread-replay-cursor");
  const message = page.getByRole("combobox", { name: "Message" });
  await message.fill("Also check the iOS cold-start path");
  await message.press("Enter");
  const queue = page.getByRole("list", { name: "Queued messages" });
  await expect(queue.getByRole("listitem")).toHaveCount(1);

  await queue.getByRole("button", { name: "Send now", exact: true }).click();

  await expect(queue).toHaveCount(0);
  await expect(
    page.getByRole("feed", { name: "Transcript" }).getByText("Also check the iOS cold-start path"),
  ).toBeVisible();
});

test("pending bubbles remain visible at the live tail and take back files alongside an existing draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 650 });
  await page.goto("/t/thread-replay-cursor");
  const message = page.getByRole("combobox", { name: "Message", exact: true });
  await page.getByLabel("Files to attach").setInputFiles({
    name: "trace.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retry trace"),
  });
  await message.fill("Check the iOS path\nPreserve its retry trace");
  await message.press("Enter");
  const queue = page.getByRole("list", { name: "Queued messages" });
  await expect(queue.getByRole("button", { name: "Take back to composer" })).toBeVisible();
  const viewport = page.locator("[data-thread-column] [data-virtual-viewport]");
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);
  await expect(async () => {
    const bubbles = await queue.boundingBox();
    const dock = await page.locator("[data-composer-dock]").boundingBox();
    if (!bubbles || !dock) throw new Error("pending bubble layout missing");
    expect(bubbles.y + bubbles.height).toBeLessThanOrEqual(dock.y);
  }).toPass();
  await message.fill("Keep my current draft");
  const takeBack = queue.getByRole("button", { name: "Take back to composer" });
  await takeBack.focus();
  await expect(page.getByRole("tooltip", { name: /Take back to composer/ })).toBeVisible();
  await takeBack.click();
  await expect(queue).toHaveCount(0);
  await expect(message).toHaveText(
    "Keep my current draft\n\nCheck the iOS path\nPreserve its retry trace",
  );
  await expect(
    page.getByRole("list", { name: "Attachments" }).getByText("trace.txt"),
  ).toBeVisible();
});

test("a limited thread moves to another account and carries on", async ({ page }) => {
  await page.goto("/t/thread-limit-search");
  const limit = page.getByRole("region", { name: "Usage limit reached" });
  await expect(limit).toBeVisible();
  await expect(page.getByRole("button", { name: /^Model: GPT-5 Codex, team/ })).toBeVisible();

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
  await page.goto("/accounts");
  const team = page.getByRole("article", { name: "Codex Team" });
  await expect(team).toContainText("3 threads are paused until the window resets");

  await team.getByRole("button", { name: "Move running threads" }).click();

  await expect(page.getByText("Moved 3 threads to Codex · Personal")).toBeVisible();
  await expect(team.getByRole("button", { name: "Move running threads" })).toHaveCount(0);
  const threads = page.getByRole("navigation", { name: "Threads" });
  // The thread list stays in the sidebar beside Usage & accounts.
  await expect(threads.getByRole("link", { name: /Split the CI matrix/ })).not.toContainText(
    "Limited",
  );
});

test("thread and new-thread drafts stay separate across navigation and a fresh reload", async ({
  page,
}) => {
  await page.goto("/t/thread-dedupe?fakeWorld=thread-activity");
  const message = page.getByRole("combobox", { name: "Message", exact: true });
  const a = page.getByRole("link", { name: /^Dedupe thread events after reconnect/ });
  const b = page.getByRole("link", { name: /^Retry budget for app-server restarts/ });
  const fresh = page.getByRole("link", { name: "New thread", exact: true });
  await message.fill("Draft A");
  await b.click();
  await expect(message).toHaveText("");
  await message.fill("Draft B");
  await a.click();
  await expect(message).toHaveText("Draft A");
  await fresh.click();
  await expect(page.getByRole("heading", { level: 1, name: "New thread" })).toBeVisible();
  await expect(message).toHaveText("");
  await message.fill("New-thread draft");
  await b.click();
  await expect(message).toHaveText("Draft B");
  await fresh.click();
  await expect(message).toHaveText("New-thread draft");
  await page.reload();
  await expect(message).toHaveText("New-thread draft");
});
