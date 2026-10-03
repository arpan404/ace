import { expect, test } from "@playwright/test";

test("a thread opens from Home and shows its transcript", async ({ page }) => {
  await page.goto("/");
  const threads = page.getByRole("navigation", { name: "Threads" });
  await threads.getByRole("link", { name: /Replay cursor resets on every resume/ }).click();

  await expect(page).toHaveURL(/\/t\/thread-replay-cursor$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Replay cursor resets on every resume" }),
  ).toBeVisible();
  const transcript = page.getByRole("feed", { name: "Transcript" });
  await expect(transcript.getByText(/After a daemon restart the web client replays/)).toBeVisible();
});

test("a message sent while the agent works is queued above the composer", async ({ page }) => {
  await page.goto("/t/thread-replay-cursor");
  const message = page.getByRole("combobox", { name: "Message" });
  await message.fill("Also check the iOS cold-start path");
  await expect(page.getByRole("button", { name: "Queue message" })).toBeVisible();
  await message.press("Enter");

  await expect(page.getByText("Also check the iOS cold-start path")).toBeVisible();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(message).toHaveValue("");
});

test("a new thread starts from ⌘N and its first message streams into the transcript", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Threads" }).waitFor();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("heading", { level: 1, name: "New thread" })).toBeVisible();

  await page
    .getByRole("combobox", { name: "Message" })
    .fill("Log every restart with its backoff delay");
  await page.keyboard.press("Enter");

  await expect(
    page.getByRole("heading", { level: 1, name: "Log every restart with its backoff delay" }),
  ).toBeVisible();
  const transcript = page.getByRole("feed", { name: "Transcript" });
  await expect(transcript.getByText("Log every restart with its backoff delay")).toBeVisible();
  await expect(transcript.getByText("Reading the project before making changes.")).toBeVisible();
});

test("⌘J opens the agent tree for the thread", async ({ page }) => {
  await page.goto("/t/thread-replay-cursor");
  await page.getByRole("feed", { name: "Transcript" }).waitFor();
  await page.keyboard.press("ControlOrMeta+j");

  const panel = page.getByRole("region", { name: "Thread panel" });
  await expect(panel.getByRole("tab", { name: "Agents", selected: true })).toBeVisible();
  await expect(panel.getByRole("group", { name: /^Main agent:/ })).toBeVisible();
  await expect(panel.getByRole("group", { name: /^reconnect-audit:/ })).toBeVisible();
});
