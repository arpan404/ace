import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { browserVideo } from "@/test/browser-video.ts";
import { harness } from "@/test/harness.tsx";

const thread = "thread-cold-start";
async function openBrowser() {
  browserVideo();
  const app = harness();
  const scenario = coldStartReplay();
  app.play(scenario).step();
  seedPanels(app.daemon);
  await app.open(`/t/${thread}`);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("img", { name: /^Live view of / });
  const browser = app.daemon.browser;
  const tabId = browser.view(thread)?.activeTabId ?? "";
  return { panel, browser, tabId };
}

test("a site's sign-in reaches the site with what the person typed, and only once", async () => {
  const { panel, browser, tabId } = await openBrowser();
  act(() => void browser.signInAsk(thread, tabId, "Staging"));
  const prompt = await within(panel).findByRole("dialog", { name: "Sign in to localhost:5173" });
  expect(within(prompt).getByText(/Staging/)).toBeTruthy();
  await userEvent.type(within(prompt).getByRole("textbox", { name: "Username" }), "ada");
  await userEvent.type(within(prompt).getByLabelText("Password"), "lovelace{Enter}");
  await waitFor(() =>
    expect(within(panel).queryByRole("dialog", { name: "Sign in to localhost:5173" })).toBeNull(),
  );
  expect(browser.signIns).toEqual([{ username: "ada", password: "lovelace" }]);
});

test("cancelling a site's sign-in sends no credentials", async () => {
  const { panel, browser, tabId } = await openBrowser();
  act(() => void browser.signInAsk(thread, tabId, "Staging"));
  const prompt = await within(panel).findByRole("dialog", { name: "Sign in to localhost:5173" });
  await userEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(browser.signIns).toEqual([null]));
});

test("the person proceeds past an untrusted certificate for the address they were shown", async () => {
  const { panel, browser, tabId } = await openBrowser();
  act(() =>
    browser.certificateFail(
      thread,
      tabId,
      "https://localhost:8443/app",
      "ERR_CERT_AUTHORITY_INVALID",
    ),
  );
  const warning = await within(panel).findByRole("alert");
  expect(within(warning).getByText("This connection isn't private")).toBeTruthy();
  expect(within(warning).getByText("localhost:8443")).toBeTruthy();
  await userEvent.click(within(warning).getByRole("button", { name: "Proceed anyway (unsafe)" }));
  await waitFor(() => expect(browser.view(thread)?.tabs?.[0]?.certificate_error).toBeUndefined());
  expect(browser.tab(thread, tabId)?.url).toBe("https://localhost:8443/app");
  await waitFor(() => expect(within(panel).queryByRole("alert")).toBeNull());
});

test("a tab playing sound shows a speaker in the address bar the person mutes and unmutes", async () => {
  const { panel, browser, tabId } = await openBrowser();
  const tabs = within(panel).getByRole("tablist", { name: "Thread panel tabs" });
  // A silent page has no speaker anywhere.
  expect(within(panel).queryByRole("button", { name: /^(Mute|Unmute) tab$/ })).toBeNull();
  expect(within(tabs).queryByRole("img", { name: /^(Muted|Playing sound)$/ })).toBeNull();

  act(() => browser.sound(thread, tabId, true, true));
  await within(tabs).findByRole("img", { name: "Muted" });
  await userEvent.click(await within(panel).findByRole("button", { name: "Unmute tab" }));
  await waitFor(() => expect(browser.tab(thread, tabId)?.muted).toBe(false));
  await within(tabs).findByRole("img", { name: "Playing sound" });
  await userEvent.click(await within(panel).findByRole("button", { name: "Mute tab" }));
  await waitFor(() => expect(browser.tab(thread, tabId)?.muted).toBe(true));
  await within(tabs).findByRole("img", { name: "Muted" });
});

test("right-clicking a browser tab mutes and unmutes it, even while it is silent", async () => {
  const { panel, browser, tabId } = await openBrowser();
  const tabs = within(panel).getByRole("tablist", { name: "Thread panel tabs" });
  const pageTab = within(tabs).getByRole("tab", { selected: true });
  await userEvent.pointer({ keys: "[MouseRight]", target: pageTab });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Mute tab" }));
  await waitFor(() => expect(browser.tab(thread, tabId)?.muted).toBe(true));
  await userEvent.pointer({ keys: "[MouseRight]", target: pageTab });
  await userEvent.click(await screen.findByRole("menuitem", { name: "Unmute tab" }));
  await waitFor(() => expect(browser.tab(thread, tabId)?.muted).toBe(false));
});

test("a page's file picker takes the files the person picks on this device", async () => {
  const { panel, browser, tabId } = await openBrowser();
  act(() => void browser.fileChooserOpen(thread, tabId, false));
  const ask = await within(panel).findByRole("dialog", { name: /asks for a file$/ });
  const file = new File(["hello"], "notes.txt", { type: "text/plain" });
  await userEvent.upload(within(ask).getByLabelText("Files for the page"), file);
  await waitFor(() =>
    expect(browser.chosenFiles).toEqual([[{ sha256: expect.any(String), name: "notes.txt" }]]),
  );
  await waitFor(() => expect(within(panel).queryByRole("dialog", { name: /asks for/ })).toBeNull());
});

test("an offline page says so and that it comes back by itself", async () => {
  const { panel, browser } = await openBrowser();
  act(() => browser.loadFailed(thread, "net::ERR_INTERNET_DISCONNECTED"));
  const card = await within(panel).findByRole("alert");
  expect(within(card).getByText("You're offline")).toBeTruthy();
  expect(within(card).getByText(/loads again by itself/)).toBeTruthy();
});
