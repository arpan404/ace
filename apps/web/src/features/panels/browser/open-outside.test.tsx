import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { browserVideo } from "@/test/browser-video.ts";
import { harness } from "@/test/harness.tsx";

const threadId = "thread-cold-start";
const page = "https://github.com/MathCancer/PhysiCell/tree/master/sample_projects?tab=readme#build";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The cold-start thread's Browser tool, showing `page`, with new browser tabs recorded. */
async function showPage() {
  browserVideo();
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  const app = harness();
  app.play(coldStartReplay()).step();
  seedPanels(app.daemon);
  await app.open(`/t/${threadId}`);
  await screen.findByRole("heading", { level: 1 });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("img", { name: /^Live view of / }, { timeout: 10000 });
  act(() => {
    app.daemon.browser.navigate(threadId, page);
  });
  await waitFor(() =>
    expect(
      (within(panel).getByRole("combobox", { name: "Address" }) as HTMLInputElement).value,
    ).toContain("github.com"),
  );
  const opens = () => opened.mock.calls.map((call) => call[0]);
  return { panel, browser: app.daemon.browser, opens };
}

test("the toolbar opens the page shown, with its path, query and fragment, in the person's own browser", async () => {
  const { panel, opens } = await showPage();
  await userEvent.click(within(panel).getByRole("button", { name: "Open in your browser" }));
  expect(opens()).toEqual([page]);
});

test("right-clicking the page offers to open it, or the link under the pointer, in the person's own browser", async () => {
  const { panel, browser, opens } = await showPage();
  browser.contextTarget = {};
  fireEvent.contextMenu(within(panel).getByRole("application"), { clientX: 20, clientY: 30 });
  let menu = await screen.findByRole("menu");
  await userEvent.click(
    await within(menu).findByRole("menuitem", { name: "Open page in your browser" }),
  );
  expect(opens()).toEqual([page]);

  browser.contextTarget = { link: "https://docs.example/next?a=1#b" };
  fireEvent.contextMenu(within(panel).getByRole("application"), { clientX: 20, clientY: 30 });
  menu = await screen.findByRole("menu");
  await userEvent.click(
    await within(menu).findByRole("menuitem", { name: "Open link in your browser" }),
  );
  expect(opens()).toEqual([page, "https://docs.example/next?a=1#b"]);
});

test("a link that isn't a web page is never offered outside ace", async () => {
  const { panel, browser } = await showPage();
  browser.contextTarget = { link: "javascript:alert(1)" };
  fireEvent.contextMenu(within(panel).getByRole("application"), { clientX: 20, clientY: 30 });
  const menu = await screen.findByRole("menu");
  await within(menu).findByRole("menuitem", { name: "Open link in new tab" });
  expect(within(menu).queryByRole("menuitem", { name: "Open link in your browser" })).toBeNull();
});
