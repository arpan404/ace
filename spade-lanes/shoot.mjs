// Usage: node shoot.mjs <base-url> <before|after> <out-dir>
import { chromium } from "@playwright/test";
const [base, tag, out] = process.argv.slice(2);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await context.newPage();
const world = "fakeWorld=spade-lanes";
const settle = (ms = 900) => page.waitForTimeout(ms);
const shot = async (name) => {
  await settle();
  await page.screenshot({ path: `${out}/${name}-${tag}.png` });
  console.log("saved", `${out}/${name}-${tag}.png`);
};
const chat = () => page.locator("[data-thread-column]").first();
const toTop = async () => {
  const box = await chat().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -2000);
};
const show = async (text) => {
  await page.getByText(text, { exact: false }).first().scrollIntoViewIfNeeded();
  await page.getByText(text, { exact: false }).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
};

// Dark, as the person would set it.
await page.goto(`${base}/settings/appearance?${world}`);
await page.getByRole("radio", { name: "Dark" }).click();
await settle();

const open = async (search = "") => {
  await page.goto(`${base}/spade/errands?${world}${search}`);
  await page.getByText("The flights are ready").first().waitFor({ timeout: 30000 });
  await settle(1500);
};

await open();
await toTop();
await shot("01-chat-top-pill");

await open();
const pill = page.getByRole("button", { name: /^Tasks:/ });
if (await pill.count()) {
  await pill.click();
  await settle(600);
}
await shot("02-task-list-popover");

await open();
await show("Clean up the shared drive: one folder per client.");
await shot("03-chat-tasks-running");

await open();
await show("The CRM comparison stopped early");
await shot("04-chat-tasks-finish");

await open();
const lane = page.getByRole("button", { name: /^Started a task: Fix the March invoice/ });
if (await lane.count()) {
  await lane.click();
  await page.getByText("Goal and plan").first().waitFor({ timeout: 15000 });
}
await shot("05-task-opened");

await open();
await page.getByRole("button", { name: "Allow" }).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
await shot("06-task-approval");

await page.goto(`${base}/settings/spade/models?${world}`);
await page.getByText("Helpers").first().waitFor({ timeout: 30000 });
await page.getByText("Helpers").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
await shot("07-roles-tasks-row");

if (tag === "after") {
  await open();
  await page
    .getByText("Draft the quarterly note asks")
    .first()
    .evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot("08-task-question");

  await open();
  await show("both changed finance/Q3-totals.xlsx");
  await shot("09-overlap-line");
}

await browser.close();
