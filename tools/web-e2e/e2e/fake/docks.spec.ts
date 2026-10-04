import { expect, test, type Page } from "@playwright/test";

/** The workspace docks: resource tabs beside and below a thread, kept per thread. */

const sidePanel = (page: Page) => page.getByRole("region", { name: "Thread panel" });
const tabs = (page: Page) =>
  sidePanel(page).getByRole("tablist", { name: "Thread panel tabs" }).getByRole("tab");

async function open(page: Page, path: string, title: string | RegExp) {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

async function launch(page: Page, tool: string) {
  await sidePanel(page).getByRole("button", { name: "New tab" }).click();
  await sidePanel(page)
    .getByRole("list", { name: "Tools" })
    .getByRole("button", { name: new RegExp(`^${tool}`) })
    .click();
}

test("the + launcher becomes the tool picked from it, and tabs reorder and close one at a time", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.getByRole("button", { name: "Right panel" }).click();
  await expect(tabs(page)).toHaveText([/^Changes/, "Agents"]);

  await launch(page, "Preview");
  await expect(tabs(page)).toHaveText([/^Changes/, "Agents", "Preview"]);
  await expect(sidePanel(page).getByRole("tab", { name: "Preview", selected: true })).toBeVisible();
  await launch(page, "Devices");
  await expect(tabs(page)).toHaveText([/^Changes/, "Agents", "Preview", "Devices"]);

  // Drag Devices before Preview; the showing tab stays Devices.
  await sidePanel(page)
    .getByRole("tab", { name: "Devices" })
    .dragTo(sidePanel(page).getByRole("tab", { name: "Preview" }), {
      targetPosition: { x: 4, y: 8 },
    });
  await expect(tabs(page)).toHaveText([/^Changes/, "Agents", "Devices", "Preview"]);
  await expect(sidePanel(page).getByRole("tab", { name: "Devices", selected: true })).toBeVisible();

  // Closing the showing tab shows its neighbour; the others stay.
  await sidePanel(page).getByRole("button", { name: "Close Devices" }).click();
  await expect(tabs(page)).toHaveText([/^Changes/, "Agents", "Preview"]);
  await expect(sidePanel(page).getByRole("tab", { name: "Preview", selected: true })).toBeVisible();
});

test("each thread keeps its own tabs, showing tab and panel, and gets them back on return", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.getByRole("button", { name: "Right panel" }).click();
  await launch(page, "Preview");

  await open(page, "/t/thread-install-page", /./);
  await expect(sidePanel(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Right panel" }).click();
  await expect(tabs(page)).toHaveText([/^Changes/, "Agents"]);

  await page.goBack();
  await expect(
    page.getByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" }),
  ).toBeVisible();
  await expect(sidePanel(page).getByRole("tab", { name: "Preview", selected: true })).toBeVisible();
});

test("full view gives the side panel the work area and Back to the conversation restores the split", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.keyboard.press("ControlOrMeta+Shift+d");
  await expect(
    sidePanel(page).getByRole("tab", { name: /^Changes/, selected: true }),
  ).toBeVisible();
  const split = (await sidePanel(page).boundingBox())?.width ?? 0;

  await sidePanel(page).getByRole("button", { name: "Full view" }).click();
  await expect(page.getByRole("feed", { name: "Transcript" })).toBeHidden();
  expect((await sidePanel(page).boundingBox())?.width ?? 0).toBeGreaterThan(split);

  await sidePanel(page)
    .getByRole("button", { name: /Cap cold-start replay/ })
    .click();
  await expect(page.getByRole("feed", { name: "Transcript" })).toBeVisible();
  expect(Math.round((await sidePanel(page).boundingBox())?.width ?? 0)).toBe(Math.round(split));
});

test("⌘J shows the bottom panel, and its Terminal moves to the side panel without losing a shell", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.keyboard.press("ControlOrMeta+j");
  const bottom = page.getByRole("region", { name: "Bottom panel" });
  await expect(bottom.getByRole("tab", { name: "Terminal", selected: true })).toBeVisible();
  await expect(bottom.getByRole("tablist", { name: "Terminals" })).toContainText("relay:soak");

  await bottom.getByRole("tab", { name: "Terminal" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to side panel" }).click();
  await expect(
    sidePanel(page).getByRole("tab", { name: "Terminal", selected: true }),
  ).toBeVisible();
  await expect(sidePanel(page).getByRole("tablist", { name: "Terminals" })).toContainText(
    "relay:soak",
  );
  await expect(bottom.getByRole("tab", { name: "Terminal" })).toHaveCount(0);
});
