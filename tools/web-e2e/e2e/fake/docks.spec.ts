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

test("⌘J shows the bottom panel, and a terminal moves to the side panel without losing its shell", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.keyboard.press("ControlOrMeta+j");
  const bottom = page.getByRole("region", { name: "Bottom panel" });
  await expect(bottom.getByRole("tab", { name: "zsh", selected: true })).toBeVisible();
  await bottom.getByRole("group", { name: "zsh terminal" }).click();
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await expect(bottom.getByRole("group", { name: "zsh terminal" })).toContainText("/Users/dev/ace");

  await bottom.getByRole("tab", { name: "zsh" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to side panel" }).click();
  await expect(sidePanel(page).getByRole("tab", { name: "zsh", selected: true })).toBeVisible();
  // The same shell, with what it printed.
  await expect(sidePanel(page).getByRole("group", { name: "zsh terminal" })).toContainText(
    "/Users/dev/ace",
  );
  await expect(bottom.getByRole("tab", { name: "zsh" })).toHaveCount(0);
});

test("with five tabs in the side panel, the showing tab stays whole inside the strip", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.getByRole("button", { name: "Right panel" }).click();
  await launch(page, "Preview");
  await launch(page, "Devices");
  await launch(page, "Files");
  await expect(tabs(page)).toHaveCount(5);
  const strip = sidePanel(page).getByRole("tablist", { name: "Thread panel tabs" });
  const inside = async (name: string | RegExp) => {
    const tab = strip.getByRole("tab", { name, selected: true });
    await expect(tab).toBeVisible();
    await expect
      .poll(async () => {
        const [box, list] = await Promise.all([tab.boundingBox(), strip.boundingBox()]);
        if (!box || !list) return false;
        return box.x >= list.x - 0.5 && box.x + box.width <= list.x + list.width + 0.5;
      })
      .toBe(true);
    // Its whole title shows: nothing is cut off with an ellipsis.
    expect(
      await tab.evaluate((element) => {
        const title = element.querySelector<HTMLElement>("[data-tab-title]");
        return title ? title.scrollWidth <= title.clientWidth : false;
      }),
    ).toBe(true);
  };
  await inside("Open file");
  // The first tab, folded or not, comes back whole when shown.
  await strip.getByRole("tab").first().click();
  await inside(/^Changes/);
  await strip.getByRole("tab").last().click();
  await inside("Open file");
});

test("with the side panel open at its default width, the thread title keeps at least 280px", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.getByRole("button", { name: "Right panel" }).click();
  await expect(sidePanel(page)).toBeVisible();
  const title = page.getByRole("heading", { level: 1 });
  // Beside a narrow column Run, Open and Commit drop their labels but stay one click away, and
  // the header keeps a single ⋯.
  const header = page.getByRole("banner");
  await expect(header.getByRole("button", { name: "Commit", exact: true })).toBeVisible();
  await expect(header.getByText("Commit", { exact: true })).not.toBeVisible();
  await expect(header.getByRole("button", { name: "More actions" })).toHaveCount(1);
  const room = await title.evaluate((element) => ({
    shown: element.clientWidth,
    whole: element.scrollWidth,
  }));
  expect(room.shown).toBeGreaterThanOrEqual(Math.min(280, room.whole));
  const box = await title.boundingBox();
  expect(box && Math.round(box.width)).toBeGreaterThanOrEqual(Math.min(280, room.whole));
});
