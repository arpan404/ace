import { expect, test, type Page } from "@playwright/test";

/*
 * Journeys across the rebuilt workspace and composer: what a person does from start to finish
 * with terminals, the per-thread tabs and the composer, checked against what the page shows and
 * what the fake daemon ends up holding.
 */

const sidePanel = (page: Page) => page.getByRole("region", { name: "Thread panel" });
const sideTabs = (page: Page) =>
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

/** The PTYs the fake daemon holds for a thread. */
const daemonTerminals = (page: Page, threadId: string) =>
  page.evaluate(
    (id) =>
      (
        globalThis as unknown as {
          ace: { daemon: { terminals: { list(id: string): { name: string }[] } } };
        }
      ).ace.daemon.terminals
        .list(id)
        .map((terminal) => terminal.name),
    threadId,
  );

test("a new terminal keeps its shell while the side panel hides, and closing its tab ends it", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.keyboard.press("ControlOrMeta+j");
  await expect(sidePanel(page).getByRole("tab", { name: "zsh", selected: true })).toBeVisible();
  const before = (await daemonTerminals(page, "thread-cold-start")).length;

  await sidePanel(page)
    .getByRole("button", { name: /^Terminal sessions/ })
    .click();
  await page.getByRole("menuitem", { name: /^New terminal/ }).click();
  await expect(sidePanel(page).getByRole("tab", { name: "zsh 2", selected: true })).toBeVisible();
  const terminal = sidePanel(page).getByRole("group", { name: "zsh 2 terminal" });
  await terminal.click();
  await page.keyboard.type("echo still-here");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("still-here");
  await expect.poll(() => daemonTerminals(page, "thread-cold-start")).toHaveLength(before + 1);

  // Hiding the panel is not closing: the shell and what it printed come back with it.
  await sidePanel(page).getByRole("button", { name: "Right panel" }).click();
  await expect(sidePanel(page)).toHaveCount(0);
  expect(await daemonTerminals(page, "thread-cold-start")).toHaveLength(before + 1);
  await page.getByRole("button", { name: "Right panel" }).click();
  await expect(sidePanel(page).getByRole("tab", { name: "zsh 2", selected: true })).toBeVisible();
  await expect(terminal).toContainText("still-here");

  // Closing the tab ends that shell, and only that one.
  await sidePanel(page).getByRole("button", { name: "Close zsh 2" }).click();
  await expect(sidePanel(page).getByRole("tab", { name: "zsh 2" })).toHaveCount(0);
  await expect(sidePanel(page).getByRole("tab", { name: "zsh", exact: true })).toBeVisible();
  await expect.poll(() => daemonTerminals(page, "thread-cold-start")).toHaveLength(before);
});

test("a thread's tabs, their order and the showing tab survive a reload, and stay its own", async ({
  page,
}) => {
  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await page.getByRole("button", { name: "Right panel" }).click();
  await launch(page, "Preview");
  await launch(page, "Devices");
  await sidePanel(page).getByRole("tab", { name: "Agents" }).click();
  await expect(sideTabs(page)).toHaveText([/^Changes/, "Agents", "Preview", "Devices"]);

  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" }),
  ).toBeVisible();
  await expect(sideTabs(page)).toHaveText([/^Changes/, "Agents", "Preview", "Devices"]);
  await expect(sidePanel(page).getByRole("tab", { name: "Agents", selected: true })).toBeVisible();

  // Another thread has its own workspace, untouched by this one's.
  await open(page, "/t/thread-replay-cursor", "Replay cursor resets on every resume");
  await expect(sidePanel(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Right panel" }).click();
  await expect(sideTabs(page)).toHaveText([/^Changes/, "Agents"]);

  await open(page, "/t/thread-cold-start", "Cap cold-start replay at 200 events");
  await expect(sideTabs(page)).toHaveText([/^Changes/, "Agents", "Preview", "Devices"]);
  await expect(sidePanel(page).getByRole("tab", { name: "Agents", selected: true })).toBeVisible();
});

test("a two-line message with a file attached starts a thread under the chosen approvals, and a follow-up queues", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Threads" }).waitFor();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("heading", { level: 1, name: "New thread" })).toBeVisible();
  const message = page.getByRole("combobox", { name: "Message" });

  await message.click();
  await page.keyboard.type("Log every restart with its backoff delay");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("and keep the last ten in memory");
  await expect(message).toHaveText(
    "Log every restart with its backoff delay\nand keep the last ten in memory",
  );

  // + › Files attaches through the file chooser.
  await page.getByRole("button", { name: "Add files and context" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("option", { name: /^Attach files/ }).click();
  await (
    await chooser
  ).setFiles({
    name: "restarts.log",
    mimeType: "text/plain",
    buffer: Buffer.from("restart 1 after 250ms\nrestart 2 after 500ms\n"),
  });
  await expect(
    page.getByRole("list", { name: "Attachments" }).getByText("restarts.log"),
  ).toBeVisible();

  await page.getByRole("button", { name: /^Approvals:/ }).click();
  await page.getByRole("menuitemradio", { name: "Ask first" }).click();
  await expect(page.getByRole("button", { name: "Approvals: Ask first" })).toBeVisible();

  await message.press("Enter");
  await expect(
    page.getByRole("heading", { level: 1, name: "Log every restart with its backoff delay" }),
  ).toBeVisible();
  const transcript = page.getByRole("feed", { name: "Transcript" });
  await expect(transcript.getByText(/and keep the last ten in memory/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approvals: Ask first/ })).toBeVisible();

  // The agent is still reading: a follow-up waits above the composer instead of interrupting.
  const composer = page.getByRole("combobox", { name: "Message" });
  await composer.fill("Also cap the delay at 30 seconds");
  await expect(page.getByRole("button", { name: "Queue message" })).toBeVisible();
  await composer.press("Enter");
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByText("Also cap the delay at 30 seconds")).toBeVisible();
  await expect(composer).toHaveText("");
});

test("an address typed in a new tab opens the browser for a thread that had no page yet", async ({
  page,
}) => {
  await open(page, "/t/thread-settings", /./);
  await page.getByRole("button", { name: "Right panel" }).click();
  await sidePanel(page).getByRole("button", { name: "New tab" }).click();
  const address = sidePanel(page).getByRole("combobox", { name: "Address" });
  await address.fill("localhost:5173");
  await address.press("Enter");

  // The browser opened for the thread and went there; nothing listens on 5173, so it says so.
  const tab = sidePanel(page).getByRole("tabpanel", { name: "localhost:5173" });
  await expect(tab.getByRole("heading", { name: "This site can't be reached" })).toBeVisible();
  await expect(tab.getByRole("combobox", { name: "Address" })).toHaveValue("localhost:5173");
});
