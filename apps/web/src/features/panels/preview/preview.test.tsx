import { FakeBrowser, coldStartReplay, failingSubagent } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { panelServices } from "../services.ts";

async function openPreview(
  scenario = coldStartReplay(),
  path = "/t/thread-cold-start",
  through?: string,
) {
  const app = harness();
  const script = app.play(scenario);
  if (through) script.runThrough(through);
  else script.step();
  await app.open(path);
  await screen.findByRole("heading", { level: 1, name: scenario.thread.title });
  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("tab", { name: "Preview" }));
  const browser = (await panelServices(app.client)).preview;
  if (!(browser instanceof FakeBrowser)) throw new Error("expected the fake browser service");
  return { app, panel, browser, script };
}

test("the preview names the agent of this thread whose browser call is running", async () => {
  const { panel, script } = await openPreview(coldStartReplay(), "/t/thread-cold-start", "turn-2");
  const status = async (name: string) =>
    (await within(panel).findByText(name, { exact: false })).closest("span")?.textContent;
  expect(await status("reconnect-audit")).toContain("is controlling the browser");

  // Once reconnect-audit's browser call ends, the thread's own agent holds the page.
  await act(async () => script.runThrough("audit-done"));
  expect(await status("Claude Code")).toContain("is controlling the browser");
});

test("the preview shows the page an agent is driving and follows its frames", async () => {
  const { panel, browser } = await openPreview();
  await within(panel).findByText("is controlling the browser", { exact: false });
  const frame = within(panel).getByRole("img", {
    name: "Live view of localhost:5173/settings/devices",
  });
  const first = frame.getAttribute("src");
  expect(decodeURIComponent(first ?? "")).toContain("iPhone 16 Pro");

  act(() => browser.type("thread-cold-start", "iPhone 16 Pro Max"));
  await waitFor(() => expect(frame.getAttribute("src")).not.toBe(first));
  expect(decodeURIComponent(frame.getAttribute("src") ?? "")).toContain("iPhone 16 Pro Max");
});

test("taking control pauses the agent, forwards clicks and keys, and hands back", async () => {
  const { panel, browser } = await openPreview();
  // Before you take control, the page is a picture: nothing is forwarded.
  expect(within(panel).queryByRole("application")).toBeNull();

  await userEvent.click(await within(panel).findByRole("button", { name: /Take control/ }));
  await within(panel).findByText("have control · the agent is paused", { exact: false });
  expect(browser.view("thread-cold-start")?.controller).toBe("human");

  const page = within(panel).getByRole("application", {
    name: "Control localhost:5173/settings/devices",
  });
  fireEvent.mouseDown(page, { clientX: 10, clientY: 20 });
  fireEvent.mouseUp(page, { clientX: 10, clientY: 20 });
  page.focus();
  await userEvent.keyboard("a");
  expect(browser.inputs.map(({ input }) => input.kind + ":" + input.event)).toEqual([
    "mouse:mousePressed",
    "mouse:mouseReleased",
    "key:keyDown",
  ]);

  // Typing by the agent is ignored while you hold control.
  const held = within(panel).getByRole("img").getAttribute("src");
  act(() => browser.type("thread-cold-start", "something else"));
  expect(within(panel).getByRole("img").getAttribute("src")).toBe(held);

  await userEvent.click(within(panel).getByRole("button", { name: /Hand back/ }));
  await within(panel).findByText("is controlling the browser", { exact: false });
  expect(browser.view("thread-cold-start")?.controller).toBe("agent");
});

test("⌃⇧C takes and hands back control from the keyboard", async () => {
  const { panel, browser } = await openPreview();
  await within(panel).findByRole("button", { name: /Take control/ });
  await userEvent.keyboard("{Control>}{Shift>}c{/Shift}{/Control}");
  await within(panel).findByRole("button", { name: /Hand back/ });
  expect(browser.view("thread-cold-start")?.controller).toBe("human");
  await userEvent.keyboard("{Control>}{Shift>}c{/Shift}{/Control}");
  await within(panel).findByRole("button", { name: /Take control/ });
});

test("Open full view shows the live page large, with the same control", async () => {
  const { panel, browser } = await openPreview();
  await userEvent.click(await within(panel).findByRole("button", { name: "Open full view" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Live view of localhost:5173/settings/devices",
  });
  await userEvent.click(within(dialog).getByRole("button", { name: /Take control/ }));
  await within(dialog).findByRole("button", { name: /Hand back/ });
  expect(browser.view("thread-cold-start")?.controller).toBe("human");
});

test("a thread with only a dev server previews it; one with neither says so", async () => {
  const { panel, browser } = await openPreview(failingSubagent(), "/t/thread-settings");
  expect(await within(panel).findByText("Nothing to preview")).toBeTruthy();

  act(() =>
    browser.serve("thread-settings", {
      port: 3000,
      origin: "http://localhost:3000",
      name: "api",
      source: "listener",
    }),
  );
  const frame = await within(panel).findByTitle("Preview of http://localhost:3000");
  expect(frame.getAttribute("src")).toBe("http://localhost:3000");
  expect(within(panel).getByRole("link", { name: "Open in browser" }).getAttribute("href")).toBe(
    "http://localhost:3000",
  );
});
